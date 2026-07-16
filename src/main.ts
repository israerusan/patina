import {
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	normalizePath,
	type WorkspaceLeaf,
} from "obsidian";
import { resolveLicenseTransition } from "./shared/licenseTransition.mjs";
import { SignalStore, newWriterId } from "./shared/signals/SignalStore";
import { SignalsBroker } from "./shared/signals/SignalsBroker";
import { EngineBroker } from "./shared/engine/EngineBroker";
import type { EngineHost, EngineStatus, InstallProgress } from "./shared/engine/EngineHost";
import { LicenseManager } from "./license/LicenseManager";
import { DEFAULT_SETTINGS, type PatinaSettings } from "./settings";
import { DecayIndex } from "./decayIndex";
import { buildQueue, toCsv } from "./core/queue.mjs";
import type { QueueRow, QueueSort } from "./core/queue.d.mts";
import type { TopicGrouping } from "./core/topics.d.mts";
import { FEATURES } from "./core/features.mjs";
import { isFeatureEnabled } from "./shared/featureGates.mjs";
import {
	MAX_SESSION_NOTES,
	SemanticService,
	type SemanticBlock,
	type SemanticProgress,
} from "./semantic";
import { DecayQueueView, VIEW_TYPE_DECAY_QUEUE } from "./ui/DecayQueueView";
import { PatinaSettingTab } from "./ui/SettingsTab";
import { StatusBar } from "./ui/StatusBar";
import { ExplorerDecorator } from "./ui/ExplorerDecorator";
import { SupersededModal } from "./ui/SupersededModal";
import { showSemanticBlock } from "./ui/pro/SemanticGate";
import { noticeProfile, noticeSnoozed, registerCommands } from "./commands";
import { PRODUCT_NAME, type PRO_UPSELL } from "./product";

/** How long a burst of continuous setting changes is coalesced before a write. */
const SAVE_DEBOUNCE_MS = 400;
/** Rescore (no disk) after the metadata settles. */
const RESCORE_DEBOUNCE_MS = 800;
/** Re-read the shared activity log (disk) after an open/rename/delete settles. */
const RELOAD_DEBOUNCE_MS = 1200;
/** Scores move because TIME passes, not only because notes do. Repaint on this cadence. */
const PERIODIC_RELOAD_MS = 300_000;

const DAY_MS = 86_400_000;
const CSV_PATH = "Decay Scores.csv";

export default class PatinaPlugin extends Plugin {
	settings: PatinaSettings = { ...DEFAULT_SETTINGS };
	/** The last verification failure, for the License section. Not persisted. */
	licenseError: string | undefined;

	readonly index = new DecayIndex(this.app);

	/** Null on mobile, on an unsupported platform, or when an incompatible client is loaded. */
	engine: EngineHost | null = null;
	/** Cached: an installed-or-running engine. checkCallback runs synchronously and cannot await. */
	private engineReady = false;

	/**
	 * The two semantic Pro features (DESIGN 8.1). It is constructed on every load, Pro or not:
	 * it gates itself on `isPro` per call, so a free user's click costs one synchronous `false`
	 * and reaches no engine. Constructing it starts nothing.
	 */
	readonly semantic = new SemanticService({
		app: this.app,
		entitled: (feature) => isFeatureEnabled(FEATURES, feature, this.settings.isPro),
		engine: () => this.engine,
		excludeFolders: () => this.settings.excludeFolders,
	});

	/** PRO. The current topic grouping, or null for the flat worklist. Never persisted. */
	topics: TopicGrouping | null = null;

	private signals: SignalStore | null = null;
	private statusBar: StatusBar | null = null;
	private explorer: ExplorerDecorator | null = null;

	private saveTimer: number | null = null;
	private rescoreTimer: number | null = null;
	private reloadTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.refreshLicense();

		// The shared activity log (DESIGN 5). Obsidian does not record when a note was OPENED,
		// so we do — and Effort Index reads the same log, and writes to it, which is why the
		// writer slot is elected rather than assumed. `record()` is a no-op in whichever
		// add-on loses the election, so the log is never double-counted.
		this.signals = new SignalStore(this.app, this.manifest.id, this.settings.signalsWriterId);

		// Constructing a host spawns NOTHING — the child starts lazily on the first request —
		// so acquiring here is cheap and is what gives the refcount a chance to be correct.
		this.engine = EngineBroker.acquire(this.app, this.manifest.id, {
			enginePath: this.settings.enginePath || undefined,
		});

		this.registerView(VIEW_TYPE_DECAY_QUEUE, (leaf: WorkspaceLeaf) => new DecayQueueView(leaf, this));

		this.statusBar = new StatusBar(this.addStatusBarItem());
		this.registerDomEvent(this.statusBar.element, "click", () => {
			void this.activateQueue();
		});

		this.explorer = new ExplorerDecorator(this, activeDocument, this.index, () =>
			this.explorerContainer()
		);
		this.explorer.start();
		this.explorer.setEnabled(this.settings.dimInExplorer);

		registerCommands(this);
		this.addSettingTab(new PatinaSettingTab(this));

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.signals?.record({ t: Date.now(), k: "open", p: file.path });
				}
				this.renderStatusBar();
				// A new `open` event changes lastOpen, which changes the score — reload rather
				// than rescore, so the number the user sees is the one we just recorded.
				this.scheduleReload();
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "md") {
					this.signals?.record({ t: Date.now(), k: "rename", p: file.path, from: oldPath });
				}
				// Snoozes are keyed by path. A rename must carry the snooze with the note, or the
				// user's "not now" silently becomes "yes, now".
				const snoozed = this.settings.snoozedUntil[oldPath];
				if (snoozed !== undefined) {
					delete this.settings.snoozedUntil[oldPath];
					this.settings.snoozedUntil[file.path] = snoozed;
					this.queueSave();
				}
				this.scheduleReload();
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.signals?.record({ t: Date.now(), k: "delete", p: file.path });
					if (this.settings.snoozedUntil[file.path] !== undefined) {
						delete this.settings.snoozedUntil[file.path];
						this.queueSave();
					}
				}
				this.scheduleReload();
			})
		);

		// `resolved` fires when metadataCache has finished a pass — which is when resolvedLinks
		// (the inbound-recency signal) is actually trustworthy. Scoring off `changed` alone
		// reads a half-built link graph.
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRescore()));
		this.registerEvent(this.app.vault.on("modify", () => this.scheduleRescore()));
		// `onLayoutChange`, not `schedule`: the explorer may have been opened, closed, or moved
		// to the other sidebar since we last looked, and the observer follows the container.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.explorer?.onLayoutChange())
		);

		this.registerInterval(window.setInterval(() => this.scheduleReload(), PERIODIC_RELOAD_MS));

		// Everything above is wiring. This is the first real work, and it is deferred until the
		// workspace is ready so a cold start does not fight the vault's own indexing pass.
		this.app.workspace.onLayoutReady(() => {
			void this.reload();
			void this.refreshEngineStatus();
		});
	}

	onunload(): void {
		this.clearTimer(this.saveTimer);
		this.saveTimer = null;
		this.clearTimer(this.rescoreTimer);
		this.rescoreTimer = null;
		this.clearTimer(this.reloadTimer);
		this.reloadTimer = null;

		// Flush BEFORE dispose: dispose() stops the debounce timer, so a buffered `open` from
		// the last few seconds would otherwise be dropped on quit.
		void this.signals?.flush();
		this.signals?.dispose();
		SignalsBroker.releaseIfOwner(this.manifest.id);

		// Cancel every in-flight embed/query BEFORE releasing the engine ref. The engine is
		// SHARED: if another Second Read add-on still holds a ref the child survives this
		// unload, and it would otherwise keep grinding through a batch whose only reader has
		// just gone away.
		this.semantic.dispose();

		// Drops this plugin's ref. When the LAST Second Read add-on releases, the engine child
		// process is killed — this is the kill path that makes a zombie sidecar impossible.
		EngineBroker.release(this.manifest.id);

		// Deliberately NOT detachLeavesOfType(): the obsidianmd `detach-leaves` rule forbids
		// it, and closing the user's sidebar on an update is rude.
	}

	// --- settings -------------------------------------------------------------

	async loadSettings(): Promise<void> {
		const loaded: unknown = await this.loadData();
		const data = (loaded ?? {}) as Record<string, unknown>;
		// A hostile or corrupt data.json must not reach the prototype chain and forge `isPro`
		// onto every object in the runtime.
		if (Object.prototype.hasOwnProperty.call(data, "__proto__")) delete data["__proto__"];

		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.halfLives = { ...DEFAULT_SETTINGS.halfLives, ...(this.settings.halfLives ?? {}) };
		this.settings.weights = { ...DEFAULT_SETTINGS.weights, ...(this.settings.weights ?? {}) };
		this.settings.bandThresholds = {
			...DEFAULT_SETTINGS.bandThresholds,
			...(this.settings.bandThresholds ?? {}),
		};
		this.settings.excludeFolders = coerceStringArray(this.settings.excludeFolders);
		this.settings.snoozedUntil = coerceNumberMap(this.settings.snoozedUntil);
		this.settings.isPro = this.settings.isPro === true;

		// EVERY string the code later calls a string method on. `data.json` is a file on the
		// user's disk: a bad merge, a sync conflict, a hand-edit, or another tool's writer can
		// leave a number or an object where a string belongs — and `licenseKey.trim()` in
		// refreshLicense() runs inside onload(), so a non-string there does not degrade the
		// plugin, it PREVENTS IT FROM LOADING, with no way to fix it from a settings tab that
		// never renders. Coercion is the difference between a wrong value and a dead plugin.
		this.settings.licenseKey = coerceString(this.settings.licenseKey);
		this.settings.licenseEmail = coerceString(this.settings.licenseEmail);
		this.settings.licenseStatus = coerceString(this.settings.licenseStatus) || "free";
		this.settings.frontmatterKey =
			coerceString(this.settings.frontmatterKey) || DEFAULT_SETTINGS.frontmatterKey;
		this.settings.defaultProfile =
			coerceString(this.settings.defaultProfile) || DEFAULT_SETTINGS.defaultProfile;
		this.settings.enginePath = coerceString(this.settings.enginePath);
		this.settings.signalsWriterId = coerceString(this.settings.signalsWriterId);

		// And the numbers that are arithmetic operands. `Date.now() + "x" * DAY_MS` is NaN, and
		// a NaN `snoozedUntil` is a snooze that silently never happens.
		this.settings.snoozeDays = coerceNumber(this.settings.snoozeDays, DEFAULT_SETTINGS.snoozeDays);
		this.settings.queueMinScore = coerceNumber(
			this.settings.queueMinScore,
			DEFAULT_SETTINGS.queueMinScore
		);

		// The shard id is generated once and then never changes — it names this plugin's own
		// append-only file. Regenerating it would orphan the history in the old shard.
		if (!this.settings.signalsWriterId) {
			this.settings.signalsWriterId = newWriterId();
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		this.clearTimer(this.saveTimer);
		this.saveTimer = null;
		await this.saveData(this.settings);
		this.engine?.updateSettings({ enginePath: this.settings.enginePath || undefined });
		this.explorer?.setEnabled(this.settings.dimInExplorer);
		this.scheduleRescore();
		this.renderStatusBar();
	}

	/** Coalesced save, for controls that fire continuously (sliders, the license textarea). */
	queueSave(): void {
		this.clearTimer(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveSettings();
		}, SAVE_DEBOUNCE_MS);
	}

	/** Flush a queued save immediately — the settings tab calls this when it closes. */
	async flushPendingSave(): Promise<void> {
		if (this.saveTimer === null) return;
		await this.saveSettings();
	}

	/**
	 * Re-verify the stored key and apply the resulting entitlement.
	 *
	 * @param persistUnchanged save even when nothing moved (so a key being typed survives a restart)
	 * @param coalesce queue the save instead of writing immediately
	 * @returns true when Pro actually FLIPPED — the caller re-renders on that, and only that
	 */
	async refreshLicense(persistUnchanged = false, coalesce = false): Promise<boolean> {
		const key = this.settings.licenseKey.trim();
		const result = key ? LicenseManager.verify(key) : null;
		const next = resolveLicenseTransition(
			{ isPro: this.settings.isPro, email: this.settings.licenseEmail },
			key,
			result,
			persistUnchanged
		);

		this.settings.isPro = next.isPro;
		this.settings.licenseEmail = next.email;
		this.licenseError = key && !next.isPro ? (result?.error ?? "Invalid license key.") : undefined;
		this.settings.licenseStatus = next.isPro ? "valid-pro" : key ? "invalid" : "free";

		if (next.flipped) this.onEntitlementChanged();
		if (next.persist) {
			if (coalesce && !next.flipped) this.queueSave();
			else await this.saveSettings();
		}
		return next.flipped;
	}

	/**
	 * Pro flipped. Patina has no Pro-only SETTING to disable — its two Pro features are
	 * actions, gated at the point of use — so all this has to do is drop the Pro-only STATE and
	 * repaint. If a Pro-only persisted toggle is ever added, turn it off here.
	 *
	 * The topic grouping is Pro-only OUTPUT, so it goes when Pro goes: a key that stops
	 * verifying must not leave the queue permanently displaying a Pro view (and `this.topics`
	 * is deliberately not persisted, so a restart cannot resurrect one either).
	 */
	private onEntitlementChanged(): void {
		if (!this.settings.isPro) {
			this.topics = null;
			this.semantic.cancelInflight();
		}
		this.renderQueueViews();
	}

	// --- scoring --------------------------------------------------------------

	/** Rescore from data already in memory. No disk. */
	private scheduleRescore(): void {
		this.clearTimer(this.rescoreTimer);
		this.rescoreTimer = window.setTimeout(() => {
			this.rescoreTimer = null;
			this.rescore();
		}, RESCORE_DEBOUNCE_MS);
	}

	/** Re-read the shared activity log, then rescore. Touches the disk. */
	private scheduleReload(): void {
		this.clearTimer(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = null;
			void this.reload();
		}, RELOAD_DEBOUNCE_MS);
	}

	private async reload(): Promise<void> {
		const store = this.signals;
		if (store) await this.index.loadSignals(() => store.readIndex());
		this.rescore();
	}

	private rescore(): void {
		this.index.rebuild(this.settings);
		this.renderQueueViews();
		this.renderStatusBar();
		this.explorer?.paint();
	}

	/**
	 * The file explorer's container, or null when no explorer is mounted right now.
	 *
	 * "file-explorer" is Obsidian's internal leaf type for the built-in explorer. It is not
	 * public API — but neither is `.nav-file-title[data-path]`, which is the only way to
	 * decorate a row at all, and resolving the leaf is what keeps the MutationObserver off
	 * `document.body` (where it would fire on every keystroke the user types into a note).
	 * If Obsidian renames the type, `getLeavesOfType` returns [] and the dimming does nothing.
	 */
	private explorerContainer(): HTMLElement | null {
		const container = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view.containerEl;
		if (!container) return null;
		// The scrolling list, when it exists — the leaf container also holds the pane header,
		// whose buttons re-render on hover.
		return container.querySelector<HTMLElement>(".nav-files-container") ?? container;
	}

	private renderStatusBar(): void {
		const path = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
		const score = path ? this.index.scoreOf(path) : null;
		this.statusBar?.render(score, this.settings.showStatusBar);
	}

	private renderQueueViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DECAY_QUEUE)) {
			const view = leaf.view;
			if (view instanceof DecayQueueView) view.render();
		}
	}

	// --- actions (called by commands.ts and the views) -------------------------

	async activateQueue(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DECAY_QUEUE)[0];
		const leaf: WorkspaceLeaf | null = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE_DECAY_QUEUE, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	async openNote(path: string, event?: MouseEvent): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		// Ctrl/Cmd-click opens in a new tab, like every other link in Obsidian.
		const newTab = Boolean(event?.ctrlKey || event?.metaKey);
		await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
	}

	explainScore(path: string): void {
		const score = this.index.scoreOf(path);
		if (!score) {
			new Notice("This note has not been scored yet.");
			return;
		}
		if (score.band === "exempt") {
			new Notice(`Exempt from decay. ${score.reasons.join(" ")}`);
			return;
		}
		const why = score.reasons.length > 0 ? ` ${score.reasons.join(" ")}` : "";
		new Notice(`Decay ${score.score} · ${score.band}.${why}`);
	}

	async snooze(path: string): Promise<void> {
		const until = Date.now() + this.settings.snoozeDays * DAY_MS;
		this.settings.snoozedUntil = { ...this.settings.snoozedUntil, [path]: until };
		await this.saveSettings();
		noticeSnoozed(basename(path), this.settings.snoozeDays);
	}

	/**
	 * Write the profile into the note's frontmatter.
	 *
	 * `processFrontMatter` and not a hand-rolled string edit: it round-trips the YAML through
	 * Obsidian's own parser, so it cannot corrupt a note whose frontmatter contains anything
	 * this plugin did not anticipate.
	 */
	async setProfile(file: TFile, profile: string): Promise<void> {
		const key = this.settings.frontmatterKey;
		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			frontmatter[key] = profile;
		});
		this.scheduleRescore();
		noticeProfile(file.basename, profile);
	}

	async setQueueSort(sort: QueueSort): Promise<void> {
		this.settings.queueSort = sort;
		await this.saveSettings();
		this.renderQueueViews();
	}

	/** The whole queue as CSV, written into the vault (free — DESIGN 4.4, `csvExport`). */
	async exportCsv(): Promise<void> {
		const rows = buildQueue(this.index.all(), {
			sort: this.settings.queueSort,
			minScore: 0,
			excludeFolders: this.settings.excludeFolders,
		});
		const csv = toCsv(rows);
		const path = normalizePath(CSV_PATH);
		const existing = this.app.vault.getFileByPath(path);
		if (existing) await this.app.vault.process(existing, () => csv);
		else await this.app.vault.create(path, csv);
		new Notice(`${PRODUCT_NAME} exported ${rows.length} notes to ${path}.`);
	}

	// --- Pro: the two semantic features (DESIGN 8.1) ---------------------------

	/**
	 * True when the two semantic Pro features can actually run: Pro AND a desktop engine that
	 * is installed. Three separate conditions, kept separate on purpose — a mobile Pro user is
	 * not being paywalled, and telling them they are would be a lie.
	 *
	 * This is the COMMAND-PALETTE predicate only (checkCallback is synchronous and cannot
	 * await). It is not the gate: the gate is inside SemanticService, which re-checks the
	 * entitlement and the engine on every call. A stale `engineReady` can therefore only cost
	 * a command its palette entry, never leak a Pro feature to a free user.
	 */
	canUseSemanticPro(): boolean {
		return (
			isFeatureEnabled(FEATURES, "topicGroups", this.settings.isPro) &&
			this.engine !== null &&
			this.engineReady
		);
	}

	async refreshEngineStatus(): Promise<EngineStatus | null> {
		if (!this.engine) {
			this.engineReady = false;
			return null;
		}
		const status = await this.engine.status();
		this.engineReady = status.state === "installed" || status.state === "running";
		return status;
	}

	/** The settings "Test engine" button. Starts nothing that is not already installed. */
	async testEngine(): Promise<EngineStatus> {
		if (!this.engine) {
			return {
				state: "unsupported",
				expectedVersion: "",
				installed: null,
				updateAvailable: false,
				byoPath: false,
				health: null,
				error: "The semantic engine runs on desktop only.",
			};
		}
		try {
			await this.engine.ensureStarted();
		} catch (error) {
			console.error("patina: engine probe failed", error);
		}
		const status = await this.refreshEngineStatus();
		return status ?? (await this.engine.status());
	}

	/** The rows a Pro run operates on: the review queue exactly as the user has configured it. */
	private queueRows(): QueueRow[] {
		return buildQueue(this.index.all(), {
			sort: "score",
			minScore: this.settings.queueMinScore,
			excludeFolders: this.settings.excludeFolders,
		});
	}

	/**
	 * PRO. Cluster the review queue by topic, so one session covers one subject (DESIGN 8.1).
	 *
	 * Every failure path here ends in `showSemanticBlock`, which SAYS WHY. None of them ends in
	 * an empty queue — "the engine is not installed" and "your notes share no topic" are opposite
	 * claims, and the whole point of the block type is that they cannot be confused.
	 */
	async groupQueueByTopic(): Promise<void> {
		const rows = this.queueRows();
		const progress = new ProgressNotice(FEATURES.topicGroups.label);
		const result = await this.semantic.topicGroups(rows, (p) => progress.update(p));
		progress.done();

		if (!result.ok) {
			this.showBlock(result.block, FEATURES.topicGroups.label, "topicGroups");
			return;
		}

		this.topics = result.value;
		await this.activateQueue();
		this.renderQueueViews();
		const groups = result.value.groups.length;
		new Notice(
			groups > 0
				? `Grouped ${rows.length === 0 ? 0 : Math.min(rows.length, MAX_SESSION_NOTES)} notes into ${groups} topic${groups === 1 ? "" : "s"}.`
				: "The engine found no topic shared by two or more notes in the queue."
		);
	}

	/** Back to the flat worklist. Free — a lapsed licence must not strand the user in a view. */
	clearTopicGroups(): void {
		this.topics = null;
		this.renderQueueViews();
	}

	/**
	 * PRO. The stale notes a NEWER note has already replaced (DESIGN 8.1, 6.5: max-sim >= 0.78
	 * from >= 2 newer notes).
	 */
	async findSuperseded(): Promise<void> {
		const rows = this.queueRows();
		const progress = new ProgressNotice(FEATURES.superseded.label);
		const result = await this.semantic.superseded(rows, (p) => progress.update(p));
		progress.done();

		if (!result.ok) {
			this.showBlock(result.block, FEATURES.superseded.label, "superseded");
			return;
		}
		new SupersededModal(this, result.value, rows.length).open();
	}

	/**
	 * The engine could not run. Say which of the five reasons it was, and — when the answer is
	 * "it is not installed" — offer the consent modal. NOTHING downloads without a click in it.
	 */
	private showBlock(
		block: SemanticBlock,
		feature: string,
		upsell: keyof typeof PRO_UPSELL
	): void {
		showSemanticBlock(this, block, feature, upsell);
	}

	/**
	 * The ONLY caller of `EngineHost.install()` in this add-on, and it is reached only from the
	 * confirm button of the shared EngineInstallModal (DESIGN 7.2 — the consent gate).
	 */
	installEngine(): void {
		const progress = new Notice("Downloading the semantic engine…", 0);
		void this.semantic
			.install((p: InstallProgress) => progress.setMessage(installMessage(p)))
			.then(async (result) => {
				progress.hide();
				if (!result.ok) {
					this.showBlock(result.block, "The semantic engine", "topicGroups");
					return;
				}
				await this.refreshEngineStatus();
				new Notice(`Engine ready — ${result.value.model}, ${result.value.dim}-dim.`);
			});
	}

	// --- activity log ---------------------------------------------------------

	/** Erases EVERY shard, not just ours — the user asked to erase their activity, not half. */
	async clearActivityLog(): Promise<void> {
		await this.signals?.clear();
		await this.reload();
	}

	// --- internals ------------------------------------------------------------

	private clearTimer(timer: number | null): void {
		if (timer !== null) window.clearTimeout(timer);
	}
}

/**
 * A Notice that stays up for the length of a semantic run and reports what it is doing.
 *
 * The first run on a real vault embeds every note, which is minutes, not milliseconds. A
 * spinner-less UI that simply goes quiet for four minutes is indistinguishable from one that
 * has crashed — and the user's next move is to click the button again, which cancels the run
 * they were waiting for.
 */
class ProgressNotice {
	private readonly notice: Notice;

	constructor(private readonly feature: string) {
		// Duration 0 = stays until hide(). It is hidden in done(), which every caller runs in
		// the success AND the failure path.
		this.notice = new Notice(`${feature}: starting…`, 0);
	}

	update(progress: SemanticProgress): void {
		const { phase, done, total } = progress;
		const label = phase === "indexing" ? "Reading notes" : "Comparing notes";
		this.notice.setMessage(
			total > 0
				? `${this.feature}: ${label} ${done} / ${total}…`
				: `${this.feature}: ${label}…`
		);
	}

	done(): void {
		this.notice.hide();
	}
}

/** DESIGN 7.2's progress copy: "Downloading engine… 18.4 MB / 44.7 MB", then the later phases. */
function installMessage(progress: InstallProgress): string {
	switch (progress.phase) {
		case "downloading": {
			const done = megabytes(progress.done ?? 0);
			const total = progress.total ? ` / ${megabytes(progress.total)}` : "";
			return `Downloading engine… ${done}${total}`;
		}
		case "verifying":
			return "Verifying the download…";
		case "extracting":
			return "Extracting…";
		case "starting":
			return "Starting the engine…";
		case "ready":
			return progress.message ?? "Engine ready.";
		default:
			return "Working…";
	}
}

function megabytes(bytes: number): string {
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	const name = slash === -1 ? path : path.slice(slash + 1);
	return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/** A string, or "". Never `String(value)` — that turns a stray object into "[object Object]". */
function coerceString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** A finite number, or the default. NaN and Infinity are not numbers you can snooze until. */
function coerceNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function coerceStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function coerceNumberMap(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object") return {};
	const out: Record<string, number> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
	}
	return out;
}
