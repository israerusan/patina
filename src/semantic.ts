import { TFile, type App } from "obsidian";
import { CHUNK_NS, chunkNote } from "./shared/engine/chunk.mjs";
import { ENGINE_DIM, ENGINE_RELEASE_PINNED } from "./shared/engine/engineRelease.mjs";
import type {
	EngineHealth,
	EngineStatus,
	InstallProgress,
	RequestOptions,
} from "./shared/engine/EngineHost";
import type { InstallPlan } from "./shared/engine/installPlan.mjs";
import { engineInstallDir } from "./core/engineCopy.mjs";
import { groupByTopic, rankSuperseded } from "./core/topics.mjs";
import type {
	NeighbourMap,
	SupersededCandidate,
	SupersededHit,
	SupersededNote,
	TopicGrouping,
	TopicNeighbour,
} from "./core/topics.d.mts";
import type { QueueRow } from "./core/queue.d.mts";
import { isExcluded } from "./core/queue.mjs";

/**
 * The semantic Pro layer: topic-grouped review sessions and superseded-note detection.
 *
 * WHAT THIS FILE IS FOR, precisely: everything Obsidian-shaped and engine-shaped that the two
 * Pro features need, and nothing that can be decided without a vault. The ranking rules are in
 * `core/topics.mjs` (pure, tested); the copy is in `core/engineCopy.mjs` (pure, tested); this
 * is the part that reads notes, chunks them with the SHARED chunker, talks to the SHARED
 * engine, and translates "no engine" into a truthful sentence instead of an empty list.
 *
 * The four rules it exists to hold:
 *
 *  1. IT NEVER SPAWNS AN ENGINE. The host comes from EngineBroker, refcounted across all five
 *     Second Read add-ons. This class is handed the host; it does not construct one, and it
 *     could not — `EngineHost` is not imported here as a value at all.
 *
 *  2. IT GATES ON `isPro` BEFORE IT TOUCHES THE ENGINE. A free user's call returns a `not-pro`
 *     block having sent no RPC, embedded nothing, and started no process. The gate is the
 *     shared `isFeatureEnabled(FEATURES, key, isPro)` — the same table the settings tab and
 *     the command palette read, so the three can never disagree about who is paying.
 *
 *  3. IT NEVER RETURNS AN EMPTY RESULT FOR A MISSING ENGINE. Every failure is a typed
 *     `SemanticBlock`, and a block is not a result: the caller renders WHY, and offers the
 *     install. "0 superseded notes" and "the engine is not installed" are opposite claims and
 *     this is the type that keeps them apart.
 *
 *  4. IT CHUNKS WITH THE SHARED CHUNKER. `chunkNote` is vendored, byte-identical in all five
 *     add-ons and drift-checked by `npm test`. A chunk id is the FNV-1a-64 of its normalized
 *     text, so a plugin that chunked differently would re-embed the same prose under different
 *     keys and quietly corrupt the shared index for everyone.
 */

/* -------------------------------------------------------------------- types -- */

/**
 * The slice of EngineHost this service uses — structural, so the tests can drive it with a
 * double and so nothing here can reach for `install()` on a whim. EngineHost satisfies it.
 */
export interface SemanticEngine {
	readonly desktop: boolean;
	status(): Promise<EngineStatus>;
	ensureStarted(): Promise<EngineHealth | null>;
	request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T>;
	cancel(forId: number): Promise<void>;
	plan(): InstallPlan | null;
	planError(): string | null;
	vaultKey(): string;
	install(onProgress?: (p: InstallProgress) => void): Promise<EngineHealth>;
}

/** Why a semantic feature did not run. Never an empty result — see rule 3. */
export type SemanticBlock =
	/** Free tier. No RPC was sent. */
	| { kind: "not-pro" }
	/** Mobile, or a renderer with no `window.require`. */
	| { kind: "desktop-only" }
	/** Desktop, but we ship no engine build for this platform/arch. */
	| { kind: "unsupported"; message: string }
	/** This build of the add-on has no pinned engine release, so there is nothing to install. */
	| { kind: "not-published" }
	/** Installable, right now, with consent. */
	| { kind: "not-installed"; plan: InstallPlan; installDir: string }
	/** It is installed and it did not work. `message` is the engine's own errno-shaped sentence. */
	| { kind: "failed"; message: string }
	/** A newer run of the same feature superseded this one. The caller renders nothing. */
	| { kind: "cancelled" };

export type SemanticResult<T> = { ok: true; value: T } | { ok: false; block: SemanticBlock };

export interface SemanticProgress {
	phase: "indexing" | "querying";
	done: number;
	total: number;
}

/** The Pro features this service implements. Both are `proOnly` AND `engine` in FEATURES. */
export type SemanticFeature = "topicGroups" | "superseded";

/** What the service needs from the plugin, without importing the plugin (which imports it). */
export interface SemanticHost {
	readonly app: App;
	/**
	 * The entitlement check, per feature, read LIVE on every call — a key pasted mid-session
	 * takes effect on the next click without a reload, and a key that stops verifying takes Pro
	 * away on the next click too. The plugin implements this as
	 * `isFeatureEnabled(FEATURES, feature, settings.isPro)`: the same shared gate, over the same
	 * table, that the settings tab and the command palette read, so the three cannot disagree.
	 */
	entitled(feature: SemanticFeature): boolean;
	/** The shared, refcounted host from EngineBroker. Null on mobile / unsupported / incompatible. */
	engine(): SemanticEngine | null;
	/** Folders the user excluded. Never indexed — an excluded note is not sent to the engine. */
	excludeFolders(): readonly string[];
}

/* ---------------------------------------------------------------- constants -- */

/**
 * How many queue notes a single Pro run looks at.
 *
 * Superseded detection costs one `query` per candidate (each note's own chunks, against every
 * newer note), so this is a real ceiling and not a guess — 50 notes is a review session, and
 * a user who wants the 51st can snooze the top of the queue and run it again. The number is in
 * the UI copy, so it is not a silent truncation.
 */
export const MAX_SESSION_NOTES = 50;

/** Neighbours asked for per note when grouping. Beyond ~8 the tail is noise at 0.6+. */
const TOPIC_K = 8;

/** Candidate superseding notes asked for per chunk. */
const SUPERSEDED_K = 5;

/** Notes per `upsert` progress tick — the UI does not need 4,000 repaints. */
const PROGRESS_EVERY = 25;

/* ------------------------------------------------------------------ service -- */

interface QueryHit {
	key: string;
	note: string;
	ord: number;
	score: number;
	heading?: string;
	preview?: string;
}

interface QueryResult {
	results: Array<{ i: number; hits: QueryHit[] }>;
}

export class SemanticService {
	private readonly host: SemanticHost;

	/** In-flight JSON-RPC ids, so a superseding run can cancel them (DESIGN 6.2, method 8). */
	private readonly inflight = new Set<number>();

	/**
	 * Bumped by every public run. An awaited step whose token is stale drops its result on the
	 * floor: the engine's answer to the PREVIOUS question must never be rendered as the answer
	 * to this one, and `cancel` is best-effort — a batch already computed will still come back.
	 */
	private runToken = 0;

	/** The vault key this service has `open`ed, so the handshake happens once per process. */
	private openedFor: string | null = null;

	constructor(host: SemanticHost) {
		this.host = host;
	}

	/* ------------------------------------------------------------ entitlement */

	/**
	 * Everything that must be true before a semantic feature can run, in the order that makes
	 * the resulting message TRUE: Pro first (a free user on a phone is not being told about
	 * their phone), then the platform, then the engine build, then the install, then the start.
	 */
	async ready(feature: SemanticFeature): Promise<SemanticResult<SemanticEngine>> {
		// FIRST, and synchronously: a free user's call reaches no engine, sends no RPC, embeds
		// nothing and starts no process. The gate is not a UI decoration — it is the first line.
		if (!this.host.entitled(feature)) return blocked({ kind: "not-pro" });

		const engine = this.host.engine();
		if (!engine || !engine.desktop) return blocked({ kind: "desktop-only" });

		// A platform we ship no build for is a different sentence from a build we have not
		// published, and both are different from "not installed". planError() distinguishes the
		// first; ENGINE_RELEASE_PINNED distinguishes the second.
		const plan = engine.plan();
		if (!plan) {
			if (!ENGINE_RELEASE_PINNED) return blocked({ kind: "not-published" });
			const message =
				engine.planError() ?? "The semantic engine has no build for this computer.";
			return blocked({ kind: "unsupported", message });
		}

		const status = await engine.status();
		if (status.state === "unsupported") {
			return blocked({
				kind: "unsupported",
				message: status.error ?? "The semantic engine has no build for this computer.",
			});
		}
		if (status.state === "not-installed") {
			return blocked({
				kind: "not-installed",
				plan,
				installDir: engineInstallDir(plan.target, plan.version),
			});
		}

		let health: EngineHealth | null;
		try {
			health = await engine.ensureStarted();
		} catch (error) {
			return blocked({ kind: "failed", message: message(error) });
		}
		// `ensureStarted()` returns null — rather than throwing — when there is simply nothing
		// installed. That is not a failure to report; it is an install to offer.
		if (!health) {
			return blocked({
				kind: "not-installed",
				plan,
				installDir: engineInstallDir(plan.target, plan.version),
			});
		}

		return { ok: true, value: engine };
	}

	/**
	 * Download, verify, extract and start the engine — from the consent modal's confirm handler
	 * and from nowhere else. The service does not decide to install; it is told to.
	 */
	async install(onProgress?: (p: InstallProgress) => void): Promise<SemanticResult<EngineHealth>> {
		const engine = this.host.engine();
		if (!engine || !engine.desktop) return blocked({ kind: "desktop-only" });
		try {
			return { ok: true, value: await engine.install(onProgress) };
		} catch (error) {
			return blocked({ kind: "failed", message: message(error) });
		}
	}

	/* ---------------------------------------------------------------- features */

	/**
	 * PRO. Cluster the review queue by topic, so one session covers one subject (DESIGN 8.1).
	 *
	 * One batched `query`: the whole session's notes go in as N texts and come back as N ranked
	 * hit-lists, which is one round trip and one cancellable id rather than fifty.
	 */
	async topicGroups(
		rows: readonly QueueRow[],
		onProgress?: (p: SemanticProgress) => void
	): Promise<SemanticResult<TopicGrouping>> {
		const gate = await this.begin("topicGroups");
		if (!gate.ok) return gate;
		const { engine, token } = gate.value;

		const session = [...rows].slice(0, MAX_SESSION_NOTES);
		if (session.length === 0) return { ok: true, value: { groups: [], ungrouped: [] } };

		try {
			const indexed = await this.indexVault(engine, token, onProgress);
			if (!indexed.ok) return indexed;

			// The query text for a note is its FIRST chunk, from the shared chunker — the most
			// representative single passage the note has, and the same text any other Second Read
			// add-on would derive from it.
			const texts: string[] = [];
			const paths: string[] = [];
			for (const row of session) {
				const text = await this.representativeText(row.path);
				if (!text) continue; // an empty note has no topic; it lands in `ungrouped`
				texts.push(text);
				paths.push(row.path);
			}
			if (texts.length === 0) return { ok: true, value: { groups: [], ungrouped: [...session] } };

			onProgress?.({ phase: "querying", done: 0, total: 1 });
			const answer = await this.rpc<QueryResult>(engine, "query", {
				ns: CHUNK_NS.NOTES,
				texts,
				k: TOPIC_K,
				minScore: 0,
			});
			if (this.stale(token)) return blocked({ kind: "cancelled" });
			onProgress?.({ phase: "querying", done: 1, total: 1 });

			const neighbours: NeighbourMap = Object.create(null) as NeighbourMap;
			for (const result of answer?.results ?? []) {
				const path = paths[result.i];
				if (path === undefined) continue;
				const best = new Map<string, number>();
				for (const hit of result.hits ?? []) {
					if (typeof hit?.note !== "string" || hit.note === path) continue;
					const prior = best.get(hit.note);
					if (prior === undefined || hit.score > prior) best.set(hit.note, hit.score);
				}
				const list: TopicNeighbour[] = [...best.entries()].map(([note, score]) => ({ note, score }));
				neighbours[path] = list;
			}

			return { ok: true, value: groupByTopic(session, neighbours) };
		} catch (error) {
			return this.toBlock(error, token);
		}
	}

	/**
	 * PRO. The stale notes a NEWER note has already replaced (DESIGN 8.1, 6.5).
	 *
	 * One `query` per candidate, because `newerThan` is the candidate's own mtime and therefore
	 * cannot be batched — the whole claim is "newer than THIS note", and a shared cutoff would
	 * make it "newer than the newest note in the batch", which is a different and wrong claim.
	 */
	async superseded(
		rows: readonly QueueRow[],
		onProgress?: (p: SemanticProgress) => void
	): Promise<SemanticResult<SupersededNote[]>> {
		const gate = await this.begin("superseded");
		if (!gate.ok) return gate;
		const { engine, token } = gate.value;

		const session = [...rows].slice(0, MAX_SESSION_NOTES);
		if (session.length === 0) return { ok: true, value: [] };

		try {
			const indexed = await this.indexVault(engine, token, onProgress);
			if (!indexed.ok) return indexed;

			// mtime and title for EVERY note in the vault: a hit carries neither, and "is this
			// hit newer than the candidate" is the entire feature. The engine is asked to enforce
			// it with `newerThan` AND it is re-checked here, from the vault itself.
			const meta = this.vaultMeta();

			const candidates: SupersededCandidate[] = [];
			let done = 0;
			for (const row of session) {
				const chunks = await this.chunksOf(row.path);
				done++;
				if (this.stale(token)) return blocked({ kind: "cancelled" });
				onProgress?.({ phase: "querying", done, total: session.length });
				if (chunks.length === 0) continue;

				const answer = await this.rpc<QueryResult>(engine, "query", {
					ns: CHUNK_NS.NOTES,
					texts: chunks.map((chunk) => chunk.text),
					k: SUPERSEDED_K,
					minScore: 0,
					exclude: [row.path],
					newerThan: row.mtime,
				});
				if (this.stale(token)) return blocked({ kind: "cancelled" });

				const hits: SupersededHit[] = [];
				for (const result of answer?.results ?? []) {
					for (const hit of result.hits ?? []) {
						if (typeof hit?.note !== "string") continue;
						const info = meta.get(hit.note);
						if (!info) continue; // a hit on a note that no longer exists in the vault
						hits.push({
							note: hit.note,
							title: info.title,
							mtime: info.mtime,
							score: hit.score,
							preview: hit.preview ?? "",
						});
					}
				}

				candidates.push({
					path: row.path,
					title: row.title,
					score: row.score,
					mtime: row.mtime,
					hits,
				});
			}

			return { ok: true, value: rankSuperseded(candidates) };
		} catch (error) {
			return this.toBlock(error, token);
		}
	}

	/* ------------------------------------------------------------- cancellation */

	/**
	 * Kill everything in flight. Called when a newer run supersedes this one, and from
	 * `onunload()` — an add-on that unloads mid-embed must not leave the SHARED engine
	 * (four other add-ons may be using it) grinding through a batch nobody will ever read.
	 */
	cancelInflight(): void {
		this.runToken++;
		const engine = this.host.engine();
		const ids = [...this.inflight];
		this.inflight.clear();
		if (!engine) return;
		for (const id of ids) void engine.cancel(id);
	}

	dispose(): void {
		this.cancelInflight();
		this.openedFor = null;
	}

	/* ---------------------------------------------------------------- internals */

	/** Gate, then claim a run token, cancelling whatever the last run left in flight. */
	private async begin(
		feature: SemanticFeature
	): Promise<SemanticResult<{ engine: SemanticEngine; token: number }>> {
		const gate = await this.ready(feature);
		if (!gate.ok) return gate;
		this.cancelInflight(); // also bumps runToken
		return { ok: true, value: { engine: gate.value, token: this.runToken } };
	}

	private stale(token: number): boolean {
		return token !== this.runToken;
	}

	/**
	 * One RPC, with its id captured SYNCHRONOUSLY so it can be cancelled. `onRequestId` fires
	 * before the frame is written to the child's stdin, which is the only moment the id exists
	 * and the caller is still on the stack — a `query` that answers in one frame emits no
	 * progress notification, so there is no other chance to learn it.
	 */
	private async rpc<T>(engine: SemanticEngine, method: string, params: unknown): Promise<T> {
		let id = -1;
		try {
			return await engine.request<T>(method, params, {
				onRequestId: (requestId) => {
					id = requestId;
					this.inflight.add(requestId);
				},
			});
		} finally {
			if (id >= 0) this.inflight.delete(id);
		}
	}

	/**
	 * Bind the engine to this vault's index, then push every note's chunks into it.
	 *
	 * The engine skips a chunk whose (ns, key) it already holds, so this is a full pass on the
	 * first run and a near no-op afterwards — the key is a content hash, so an unedited note
	 * costs one frame and zero embeddings.
	 *
	 * EXCLUDED FOLDERS ARE NEVER SENT. "Notes in these folders are never scored or listed" has
	 * to mean the semantic features too, or the setting would quietly ship the user's Archive
	 * to an embedding model they told us to leave alone.
	 */
	private async indexVault(
		engine: SemanticEngine,
		token: number,
		onProgress?: (p: SemanticProgress) => void
	): Promise<SemanticResult<true>> {
		const vaultKey = engine.vaultKey();
		if (this.openedFor !== vaultKey) {
			// `open` binds the process to this vault's index and every other index method returns
			// NOT_OPEN until it succeeds (DESIGN 6.2). It is idempotent per vault, so this runs
			// once per engine start — and the flag is cleared by dispose(), never cached across
			// a restart of the child.
			await this.rpc(engine, "open", { vaultKey, dim: ENGINE_DIM });
			if (this.stale(token)) return blocked({ kind: "cancelled" });
			this.openedFor = vaultKey;
		}

		const files = this.markdownFiles();
		let done = 0;
		onProgress?.({ phase: "indexing", done, total: files.length });

		for (const file of files) {
			const chunks = await this.chunksOf(file.path);
			if (this.stale(token)) return blocked({ kind: "cancelled" });
			if (chunks.length > 0) {
				await this.rpc(engine, "upsert", {
					ns: CHUNK_NS.NOTES,
					note: file.path,
					mtime: file.stat.mtime,
					chunks,
				});
				if (this.stale(token)) return blocked({ kind: "cancelled" });
			}
			done++;
			if (done % PROGRESS_EVERY === 0 || done === files.length) {
				onProgress?.({ phase: "indexing", done, total: files.length });
			}
		}

		return { ok: true, value: true };
	}

	private markdownFiles(): TFile[] {
		const exclude = this.host.excludeFolders();
		return this.host.app.vault
			.getMarkdownFiles()
			.filter((file) => !isExcluded(file.path, exclude));
	}

	/** path -> { title, mtime } for every markdown note. */
	private vaultMeta(): Map<string, { title: string; mtime: number }> {
		const meta = new Map<string, { title: string; mtime: number }>();
		for (const file of this.host.app.vault.getMarkdownFiles()) {
			meta.set(file.path, { title: file.basename, mtime: file.stat.mtime });
		}
		return meta;
	}

	/** A note's chunks, via the SHARED chunker. `cachedRead` — never `read` — this is a scan. */
	private async chunksOf(path: string): Promise<ReturnType<typeof chunkNote>> {
		const file = this.host.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return [];
		try {
			return chunkNote(await this.host.app.vault.cachedRead(file));
		} catch {
			return []; // an unreadable note costs its own chunks, not the run
		}
	}

	/** The single passage that stands for a note when grouping: its title and its first chunk. */
	private async representativeText(path: string): Promise<string> {
		const file = this.host.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return "";
		const chunks = await this.chunksOf(path);
		if (chunks.length === 0) return "";
		return `${file.basename}\n\n${chunks[0].text}`;
	}

	/**
	 * An engine error becomes a `failed` block — never an empty result. The one exception is a
	 * CANCELLED frame, which is this add-on's own doing: a newer run superseded this one and the
	 * engine is telling us it dropped the old batch, exactly as asked.
	 */
	private toBlock(error: unknown, token: number): SemanticResult<never> {
		if (this.stale(token) || codeOf(error) === "CANCELLED") return blocked({ kind: "cancelled" });
		return blocked({ kind: "failed", message: message(error) });
	}
}

/* ------------------------------------------------------------------ helpers -- */

function blocked(block: SemanticBlock): { ok: false; block: SemanticBlock } {
	return { ok: false, block };
}

function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "";
}

/**
 * The sentence to show the user. EngineHost already turns an errno into one (`EACCES` becomes
 * "Your system blocked the engine from running…"), so an Error's message is exactly what we
 * want. Anything else is stringified only when it is a primitive: `String({})` is
 * "[object Object]", which is not an error message, it is a bug report with the bug removed.
 */
function message(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	if (typeof error === "number" || typeof error === "boolean") return String(error);
	return "The engine failed.";
}
