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
import type { EngineHost, EngineStatus } from "./shared/engine/EngineHost";
import { LicenseManager } from "./license/LicenseManager";
import { DEFAULT_SETTINGS, type NoteDecaySettings } from "./settings";
import { DecayIndex } from "./decayIndex";
import { buildQueue, toCsv } from "./core/queue.mjs";
import type { QueueSort } from "./core/queue.d.mts";
import { DecayQueueView, VIEW_TYPE_DECAY_QUEUE } from "./ui/DecayQueueView";
import { NoteDecaySettingTab } from "./ui/SettingsTab";
import { StatusBar } from "./ui/StatusBar";
import { ExplorerDecorator } from "./ui/ExplorerDecorator";
import { noticeProfile, noticeSnoozed, registerCommands } from "./commands";
import { PRODUCT_NAME } from "./product";

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

export default class NoteDecayPlugin extends Plugin {
	settings: NoteDecaySettings = { ...DEFAULT_SETTINGS };
	/** The last verification failure, for the License section. Not persisted. */
	licenseError: string | undefined;

	readonly index = new DecayIndex(this.app);

	/** Null on mobile, on an unsupported platform, or when an incompatible client is loaded. */
	engine: EngineHost | null = null;
	/** Cached: an installed-or-running engine. checkCallback runs synchronously and cannot await. */
	private engineReady = false;

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

		this.explorer = new ExplorerDecorator(this, activeDocument, this.index);
		this.explorer.start();
		this.explorer.setEnabled(this.settings.dimInExplorer);

		registerCommands(this);
		this.addSettingTab(new NoteDecaySettingTab(this));

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
		this.registerEvent(this.app.workspace.on("layout-change", () => this.explorer?.schedule()));

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
	 * Pro flipped. Note Decay has no Pro-only SETTING to disable — its two Pro features are
	 * actions, gated at the point of use — so all this has to do is repaint the surfaces that
	 * render a Pro affordance. If a Pro-only persisted toggle is ever added, turn it off here.
	 */
	private onEntitlementChanged(): void {
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

	// --- Pro (stubbed until the semantic engine ships — DESIGN 8.1 / phase 4) --

	/**
	 * True when the two semantic Pro features can actually run: Pro AND a desktop engine that
	 * is installed. Three separate conditions, kept separate on purpose — a mobile Pro user is
	 * not being paywalled, and telling them they are would be a lie.
	 */
	canUseSemanticPro(): boolean {
		return this.settings.isPro && this.engine !== null && this.engineReady;
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
			console.error("note-decay: engine probe failed", error);
		}
		const status = await this.refreshEngineStatus();
		return status ?? (await this.engine.status());
	}

	/**
	 * PRO, PHASE 4. The queue clustered by topic, so one review session covers one subject.
	 *
	 * The gate, the command, the settings row and the button are all wired NOW — what is not
	 * wired is the `query` call, because the semantic engine has no published release to pin
	 * yet (shared/engine/engineRelease.mjs still reports ENGINE_RELEASE_PINNED === false, and
	 * EngineHost refuses to download an executable it cannot checksum). This says so instead
	 * of failing silently.
	 */
	groupQueueByTopic(): void {
		if (!this.settings.isPro) return; // The caller (ProGate) has already shown the upsell.
		new Notice(
			this.engine
				? "Topic grouping needs the semantic engine, which is not available in this release yet."
				: "Topic grouping needs the semantic engine, which runs on desktop only."
		);
	}

	/** PRO, PHASE 4. See groupQueueByTopic(). */
	findSuperseded(): void {
		if (!this.settings.isPro) return;
		new Notice(
			this.engine
				? "Superseded-note detection needs the semantic engine, which is not available in this release yet."
				: "Superseded-note detection needs the semantic engine, which runs on desktop only."
		);
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

function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	const name = slash === -1 ? path : path.slice(slash + 1);
	return name.endsWith(".md") ? name.slice(0, -3) : name;
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
