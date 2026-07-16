import type { App, TFile } from "obsidian";
import { decayScore, inboundRecency, profileFromFrontmatter } from "./core/decay.mjs";
import { isExcluded } from "./core/queue.mjs";
import type { DecayOptions, DecayScore } from "./core/decay.d.mts";
import type { QueueRow } from "./core/queue.d.mts";
import type { SignalsIndex } from "./shared/signals/signalsAggregate.mjs";
import type { PatinaSettings } from "./settings";

/**
 * Everything that turns a vault into a list of scored notes, in one place.
 *
 * The scoring itself is pure and lives in core/decay.mjs. This class is the thin,
 * Obsidian-facing half: it reads mtimes from the vault, the last-opened aggregate from the
 * shared signals store, inbound-link recency from `metadataCache.resolvedLinks`, and the
 * per-note half-life from frontmatter — and hands all four to the pure scorer.
 *
 * IT IS A CACHE, AND IT IS REBUILT WHOLESALE. Scoring 5,000 notes is a few milliseconds of
 * arithmetic over data Obsidian already has in memory; the expensive part is `readIndex()`,
 * which touches the disk. So the refresh is debounced by the caller, not made incremental
 * here — incremental invalidation of a score that depends on OTHER notes' mtimes (inbound
 * recency) is exactly the kind of cleverness that ships a stale queue.
 */
export class DecayIndex {
	private readonly app: App;
	private rowsByPath = new Map<string, QueueRow>();
	private signals: SignalsIndex = {};

	constructor(app: App) {
		this.app = app;
	}

	/** Every scored note, unsorted and unfiltered. The queue does its own ranking. */
	all(): QueueRow[] {
		return [...this.rowsByPath.values()];
	}

	get(path: string): QueueRow | null {
		return this.rowsByPath.get(path) ?? null;
	}

	scoreOf(path: string): DecayScore | null {
		const row = this.rowsByPath.get(path);
		if (!row) return null;
		return { score: row.score, band: row.band, reasons: row.reasons, halfLifeDays: row.halfLifeDays };
	}

	/** Fold the shared signals log. The only disk read in the whole refresh. */
	async loadSignals(read: () => Promise<SignalsIndex>): Promise<void> {
		try {
			this.signals = await read();
		} catch (error) {
			// A corrupt or unreadable log costs us `lastOpen`, not the plugin: the score
			// renormalizes over the signals that remain and the queue still works.
			console.error("patina: could not read the activity log", error);
			this.signals = {};
		}
	}

	/**
	 * Rescore every markdown note. Synchronous on purpose — it reads only from
	 * `metadataCache` and the `TFile` stats, both already in memory.
	 *
	 * EXCLUDED FOLDERS ARE DROPPED HERE, at the source, and not in `buildQueue` alone. The
	 * setting promises the note is "never scored or listed"; filtering only inside the queue
	 * kept that promise for the queue and the CSV and broke it everywhere else — the file
	 * explorer still dimmed the row, and the status bar still announced "Decay 91 · decayed"
	 * on a note in a folder the user had explicitly excluded. Every surface reads the index,
	 * so the index is the one place where the exclusion is worth enforcing.
	 *
	 * The excluded notes DO still contribute to `inboundRecency`: a link from an archived note
	 * is still a link, and pretending the Archive folder does not exist would make every note
	 * it points at look more abandoned than it is.
	 */
	rebuild(settings: PatinaSettings, now: number = Date.now()): void {
		const files: TFile[] = this.app.vault.getMarkdownFiles();

		const mtimeByPath: Record<string, number> = {};
		for (const file of files) mtimeByPath[file.path] = file.stat.mtime;

		const inbound = inboundRecency(this.app.metadataCache.resolvedLinks, mtimeByPath);
		const options = this.decayOptions(settings);

		const next = new Map<string, QueueRow>();
		for (const file of files) {
			if (isExcluded(file.path, settings.excludeFolders)) continue;
			const signals = this.signals[file.path];
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const profile = profileFromFrontmatter(frontmatter, settings.frontmatterKey);

			const score = decayScore(
				{
					mtime: file.stat.mtime,
					lastOpen: signals?.lastOpen ?? 0,
					// A note we have never seen opened is dated from when the signals store first
					// noticed it — and, failing that, from its own ctime. Never from 0: the epoch
					// would score every note in a fresh install as maximally decayed on day one.
					firstSeen: signals?.firstSeen ?? file.stat.ctime,
					newestInboundMtime: inbound[file.path] ?? 0,
					profile,
					snoozedUntil: settings.snoozedUntil[file.path] ?? 0,
				},
				now,
				options
			);

			next.set(file.path, {
				path: file.path,
				title: file.basename,
				score: score.score,
				band: score.band,
				reasons: score.reasons,
				halfLifeDays: score.halfLifeDays,
				mtime: file.stat.mtime,
				lastOpen: signals?.lastOpen ?? 0,
				newestInboundMtime: inbound[file.path] ?? 0,
				editMs: signals?.editMs ?? 0,
				revisions: signals?.revisions ?? 0,
			});
		}

		this.rowsByPath = next;
	}

	/** The settings, in the shape the pure scorer wants. */
	private decayOptions(settings: PatinaSettings): DecayOptions {
		return {
			halfLives: settings.halfLives,
			weights: settings.weights,
			bands: settings.bandThresholds,
			defaultProfile: settings.defaultProfile,
		};
	}
}
