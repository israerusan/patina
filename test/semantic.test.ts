// The Pro layer, against a fake engine.
//
// THE BUG THIS FILE EXISTS AGAINST, verbatim: the add-on shipped a "$29 — Unlock Pro" button
// for two features that did not exist. A buyer paid, waited for a hand-emailed key, pasted it,
// saw "Pro active", and observed NO CHANGE WHATSOEVER. `isPro` gated nothing.
//
// So this asserts the four things that have to be true for the money to be honest:
//   1. a free user's call reaches NO engine — the gate is the first line, not the UI;
//   2. a Pro user's call produces REAL grouping and REAL superseded detection;
//   3. when there is no engine, the answer is a typed BLOCK — never an empty result, which a
//      user reads as "nothing found";
//   4. it goes through the SHARED chunker and the SHARED broker's host, and it cancels a
//      superseded request through the onRequestId/cancel path.
import assert from "node:assert";
import { SemanticService, type SemanticEngine, type SemanticHost } from "../src/semantic";
import { chunkNote } from "../src/shared/engine/chunk.mjs";
import { TFile } from "obsidian";
import type { QueueRow } from "../src/core/queue.d.mts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-14T00:00:00.000Z");
const ago = (days: number) => NOW - days * DAY;

/* ------------------------------------------------------------- the vault ---- */

interface Note {
	path: string;
	body: string;
	mtime: number;
}

const NOTES: Note[] = [
	{ path: "crdt.md", body: para("We dropped the CRDT plan because merge conflicts got worse"), mtime: ago(400) },
	{ path: "storage.md", body: para("Storage layer notes, rejected designs, and the merge story"), mtime: ago(380) },
	{ path: "taxes.md", body: para("Quarterly taxes, receipts, and the accountant's checklist"), mtime: ago(300) },
	{ path: "receipts.md", body: para("Where the receipts live and how they are filed each quarter"), mtime: ago(290) },
	// Newer notes. These are what can SUPERSEDE the stale ones — they are not in the queue.
	{ path: "storage-2026.md", body: para("The storage decision, rewritten, with the merge story"), mtime: ago(5) },
	{ path: "merge-final.md", body: para("Final word on merge conflicts and why CRDTs were dropped"), mtime: ago(3) },
];

/** A body long enough that the chunker keeps it (minChars is 120). */
function para(text: string): string {
	return `${text}. ${"This paragraph exists so the note survives the chunker's minimum length. ".repeat(3)}`;
}

function tfile(note: Note): TFile {
	const file = new TFile();
	file.path = note.path;
	file.basename = note.path.replace(/\.md$/, "");
	file.extension = "md";
	file.stat = { mtime: note.mtime, ctime: note.mtime };
	return file;
}

const FILES = NOTES.map(tfile);

const app = {
	vault: {
		getMarkdownFiles: () => FILES,
		getFileByPath: (path: string) => FILES.find((f) => f.path === path) ?? null,
		cachedRead: async (file: TFile) => NOTES.find((n) => n.path === file.path)?.body ?? "",
	},
};

/** The review queue: the four stale notes. */
function queue(): QueueRow[] {
	return NOTES.filter((n) => n.mtime < ago(100)).map((n, i) => ({
		path: n.path,
		title: n.path.replace(/\.md$/, ""),
		score: 90 - i,
		band: "decayed" as const,
		reasons: [],
		halfLifeDays: 90,
		mtime: n.mtime,
		lastOpen: 0,
		newestInboundMtime: 0,
		editMs: 0,
		revisions: 0,
	}));
}

/* ------------------------------------------------------------ the engine ---- */

interface Call {
	method: string;
	params: Record<string, unknown>;
	id: number;
}

/** Structurally an EngineHost, and nothing more — the service is handed one; it never spawns. */
class FakeEngine implements SemanticEngine {
	readonly calls: Call[] = [];
	readonly cancelled: number[] = [];
	desktop = true;
	state: "not-installed" | "installed" | "running" | "unsupported" = "running";
	hasPlan = true;
	startFails: string | null = null;
	/** Held responses, so a test can leave a request in flight and supersede it. */
	gate: (() => void) | null = null;

	private nextId = 1;

	/** note -> the hits `query` should answer with for any text from that note. */
	hits: Record<string, Array<{ note: string; score: number }>> = {};

	async status() {
		return {
			state: this.state,
			expectedVersion: "1.0.0",
			installed: null,
			updateAvailable: false,
			byoPath: false,
			health: null,
		} as never;
	}

	async ensureStarted() {
		if (this.startFails) throw new Error(this.startFails);
		if (this.state === "not-installed") return null;
		return { ok: true, version: "1.0.0", engine: "onnx", model: "all-MiniLM-L6-v2", dim: 384, pid: 1, vault: null, chunks: 0 };
	}

	plan() {
		return this.hasPlan
			? ({
					target: "win-x64",
					version: "1.0.0",
					tag: "sidecar-v1.0.0",
					assetName: "embed-sidecar-win-x64.zip",
					url: "https://github.com/israerusan/second-read-engine/releases/download/sidecar-v1.0.0/embed-sidecar-win-x64.zip",
					sha256: "a".repeat(64),
					executable: "embed-sidecar.exe",
				} as never)
			: null;
	}

	planError() {
		return this.hasPlan ? null : "The semantic engine has no build for freebsd/arm64.";
	}

	vaultKey() {
		return "deadbeefdeadbeef";
	}

	async install() {
		return { ok: true, version: "1.0.0", engine: "onnx", model: "all-MiniLM-L6-v2", dim: 384, pid: 1, vault: null, chunks: 0 };
	}

	async cancel(forId: number) {
		this.cancelled.push(forId);
	}

	async request<T>(method: string, params?: unknown, options?: { onRequestId?: (id: number) => void }): Promise<T> {
		const id = this.nextId++;
		options?.onRequestId?.(id);
		this.calls.push({ method, params: (params ?? {}) as Record<string, unknown>, id });

		if (this.gate) await new Promise<void>((resolve) => (this.gate = resolve));

		if (method === "query") {
			const texts = ((params as { texts?: string[] }).texts ?? []) as string[];
			const exclude = ((params as { exclude?: string[] }).exclude ?? []) as string[];
			const newerThan = (params as { newerThan?: number }).newerThan ?? 0;
			const results = texts.map((text, i) => ({
				i,
				hits: (this.hits[owner(text)] ?? [])
					.filter((hit) => !exclude.includes(hit.note))
					.filter((hit) => (NOTES.find((n) => n.path === hit.note)?.mtime ?? 0) > newerThan)
					.map((hit) => ({ key: "k", note: hit.note, ord: 0, score: hit.score, preview: "" })),
			}));
			return { results } as T;
		}
		return {} as T;
	}
}

/** Which note a query text came from — the fake engine's stand-in for an embedding. */
function owner(text: string): string {
	for (const note of NOTES) {
		const first = chunkNote(note.body)[0];
		if (first && text.includes(first.text.slice(0, 40))) return note.path;
	}
	return "";
}

function service(engine: SemanticEngine | null, isPro: boolean): SemanticService {
	const host: SemanticHost = {
		app: app as never,
		entitled: () => isPro,
		engine: () => engine,
		excludeFolders: () => [],
	};
	return new SemanticService(host);
}

/* ---------------------------------------------------------------- the tests -- */

async function main(): Promise<void> {
	// --- 1. THE GATE. A free user reaches no engine. ------------------------------
	{
		const engine = new FakeEngine();
		const free = service(engine, false);

		const grouped = await free.topicGroups(queue());
		const superseded = await free.superseded(queue());

		assert.equal(grouped.ok, false);
		assert.equal(superseded.ok, false);
		assert.equal(grouped.ok === false && grouped.block.kind, "not-pro");
		assert.equal(superseded.ok === false && superseded.block.kind, "not-pro");

		// This is the whole point. Not "the UI hid the button" — NOTHING was embedded, no note
		// was read, no process was started, no RPC was sent.
		assert.equal(engine.calls.length, 0, "a free user's click must not reach the engine at all");
	}

	// --- 2. PRO + a working engine: the features actually DO something -------------
	{
		const engine = new FakeEngine();
		engine.hits = {
			// crdt is on the same TOPIC as storage (0.62 clears the 0.60 grouping floor) but is
			// not COVERED by it (0.62 is nowhere near the 0.78 superseding floor). Two different
			// thresholds, two different claims — this fixture is what keeps them apart.
			"crdt.md": [
				{ note: "storage.md", score: 0.62 },
				{ note: "merge-final.md", score: 0.88 },
			],
			"storage.md": [
				{ note: "crdt.md", score: 0.81 },
				{ note: "storage-2026.md", score: 0.86 },
				{ note: "merge-final.md", score: 0.8 },
			],
			"taxes.md": [{ note: "receipts.md", score: 0.9 }],
			"receipts.md": [{ note: "taxes.md", score: 0.9 }],
		};
		const pro = service(engine, true);

		const grouped = await pro.topicGroups(queue());
		assert.equal(grouped.ok, true);
		if (!grouped.ok) throw new Error("unreachable");
		assert.equal(grouped.value.groups.length, 2, "crdt~storage and taxes~receipts are two topics");
		assert.deepEqual(
			grouped.value.groups.map((g) => g.members.map((m) => m.path)).sort(),
			[["crdt.md", "storage.md"], ["taxes.md", "receipts.md"]].sort()
		);

		// It went through the SHARED chunker: every chunk key the engine was sent is one
		// chunkNote() produced. A plugin that chunked its own way would embed the same prose
		// under different keys and corrupt the index for the other four add-ons.
		const upserts = engine.calls.filter((c) => c.method === "upsert");
		assert.ok(upserts.length > 0, "the vault is indexed before it is queried");
		for (const call of upserts) {
			const note = String(call.params.note);
			const body = NOTES.find((n) => n.path === note)?.body ?? "";
			const expected = chunkNote(body).map((chunk) => chunk.key);
			const sent = (call.params.chunks as Array<{ key: string }>).map((chunk) => chunk.key);
			assert.deepEqual(sent, expected, `${note} must be chunked by the shared chunker`);
			assert.equal(call.params.ns, "notes");
		}
		// The handshake happened, once, before anything was upserted (DESIGN 6.2: every other
		// index method returns NOT_OPEN until `open` succeeds).
		assert.equal(engine.calls[0].method, "open");
		assert.equal(engine.calls.filter((c) => c.method === "open").length, 1);
		assert.equal(engine.calls[0].params.vaultKey, engine.vaultKey());

		// --- superseded ---
		const stale = await pro.superseded(queue());
		assert.equal(stale.ok, true);
		if (!stale.ok) throw new Error("unreachable");

		// storage.md is covered by TWO newer notes (storage-2026 at 0.86, merge-final at 0.80).
		//
		// crdt.md is covered by ONE (merge-final at 0.88); its other neighbour, storage.md, is
		// newer but only 0.62 similar — same topic, not the same content. One newer note is a
		// follow-up, not a replacement, and flagging it would be how a tool talks someone into
		// deleting a note they still needed.
		//
		// taxes.md is covered by ONE newer note (receipts.md). receipts.md's only neighbour,
		// taxes.md, is OLDER — and an older note supersedes nothing, however similar.
		assert.deepEqual(
			stale.value.map((s) => s.path),
			["storage.md"],
			"two newer notes supersede storage.md; ONE newer note does not supersede crdt.md or taxes.md"
		);
		assert.deepEqual(
			stale.value[0].by.map((n) => n.path).sort(),
			["merge-final.md", "storage-2026.md"]
		);

		// Every superseded query asked the engine for NEWER notes only, and excluded the note
		// itself — the two constraints the whole claim rests on.
		const queries = engine.calls.filter((c) => c.method === "query" && c.params.newerThan !== undefined);
		assert.ok(queries.length >= 4);
		for (const call of queries) {
			const note = (call.params.exclude as string[])[0];
			const row = queue().find((r) => r.path === note);
			assert.ok(row, "every superseded query excludes its own note");
			assert.equal(call.params.newerThan, row.mtime, "…and asks only for notes newer than it");
		}
	}

	// --- 3. NO ENGINE: a block, never an empty result ------------------------------
	{
		// (a) mobile / no window.require — EngineBroker handed back null.
		const mobile = service(null, true);
		const result = await mobile.superseded(queue());
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.block.kind, "desktop-only");

		// (b) desktop, engine not installed: the block CARRIES the install plan, so the caller
		// can offer the consent modal. It does not carry an empty list.
		const engine = new FakeEngine();
		engine.state = "not-installed";
		const pro = service(engine, true);
		const grouped = await pro.topicGroups(queue());
		assert.equal(grouped.ok, false);
		if (grouped.ok) throw new Error("unreachable");
		assert.equal(grouped.block.kind, "not-installed");
		assert.ok(grouped.block.kind === "not-installed" && grouped.block.plan.url.startsWith("https://github.com/"));
		assert.ok(
			grouped.block.kind === "not-installed" &&
				grouped.block.installDir.includes("second-read-engine") &&
				!grouped.block.installDir.includes(".obsidian"),
			"the engine installs OUTSIDE the vault (DESIGN 7.1)"
		);
		// Not one byte was fetched, and nothing was embedded: the block is raised BEFORE any work.
		assert.equal(engine.calls.length, 0, "a missing engine must not send RPCs");

		// (c) desktop, no build for this platform.
		const exotic = new FakeEngine();
		exotic.hasPlan = false;
		const unsupported = await service(exotic, true).superseded(queue());
		assert.equal(unsupported.ok, false);
		// ENGINE_RELEASE_PINNED is false in this build, so an unpinned release is reported first
		// — which is the truth: there is nothing published to have a build FOR.
		assert.ok(
			unsupported.ok === false &&
				(unsupported.block.kind === "unsupported" || unsupported.block.kind === "not-published")
		);

		// (d) installed, and it will not start. The engine's own sentence reaches the user.
		const broken = new FakeEngine();
		broken.state = "installed";
		broken.startFails = "Your antivirus may have quarantined the engine.";
		const failed = await service(broken, true).topicGroups(queue());
		assert.equal(failed.ok, false);
		assert.equal(failed.ok === false && failed.block.kind, "failed");
		assert.match(
			failed.ok === false && failed.block.kind === "failed" ? failed.block.message : "",
			/antivirus/,
			"the errno-shaped sentence EngineHost built is what the user reads"
		);
	}

	// --- 4. CANCELLATION: a superseding run kills the one in flight ----------------
	{
		const engine = new FakeEngine();
		const pro = service(engine, true);

		// Hold the first request open.
		engine.gate = () => undefined;
		const first = pro.topicGroups(queue());
		await tick();
		const inflight = engine.calls[0].id;
		assert.ok(inflight >= 1, "the request id is handed back synchronously, via onRequestId");

		// A second run supersedes it. This is the onRequestId/cancel path (DESIGN 6.2, method 8).
		pro.cancelInflight();
		assert.deepEqual(engine.cancelled, [inflight], "the in-flight request is cancelled by id");

		// Let the held request finish. Its answer belongs to a run that no longer exists and must
		// be dropped — rendering it would show the answer to the PREVIOUS question.
		const release = engine.gate as unknown as () => void;
		engine.gate = null;
		release();
		const result = await first;
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.block.kind, "cancelled");
	}

	// --- 5. an empty queue is an empty RESULT, not a block -------------------------
	// Nothing to review is a legitimate finding, and it is the ONLY way an ok-but-empty value is
	// allowed to happen.
	{
		const engine = new FakeEngine();
		const pro = service(engine, true);
		const grouped = await pro.topicGroups([]);
		assert.equal(grouped.ok, true);
		assert.deepEqual(grouped.ok && grouped.value.groups, []);
		assert.equal(engine.calls.length, 0, "an empty queue does not need an engine either");
	}
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
