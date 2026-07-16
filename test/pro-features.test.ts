// The Pro layer, driven through the PLUGIN — the surfaces a buyer actually touches.
//
// THE BUG, VERBATIM: "$29 — Unlock Pro" bought two features that did not exist. `isPro` gated
// nothing. A buyer pasted their key, saw "Pro active", clicked "Group the queue", and got a
// Notice telling them the feature was not in this release.
//
// What is asserted here, end to end:
//   1. Pro + a working engine ⇒ the review queue is ACTUALLY grouped, in the view, by topic.
//   2. The grouping never loses a note — every queue row appears in exactly one section.
//   3. No engine ⇒ a modal that says WHY, and offers the install through the SHARED consent
//      gate. Not an empty queue. Not a shrug.
//   4. NOTHING is downloaded until the user clicks "Download and run" in that consent modal.
//   5. Losing Pro drops the Pro view.
import assert from "node:assert";
import PatinaPlugin from "../src/main";
import { DecayQueueView } from "../src/ui/DecayQueueView";
import { chunkNote } from "../src/shared/engine/chunk.mjs";
import { FakeEl, Setting, TFile, notices, openedModals } from "./obsidian-stub";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-14T00:00:00.000Z");
const ago = (days: number) => NOW - days * DAY;

(globalThis as Record<string, unknown>).window = {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: number) => clearTimeout(id),
	setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
	clearInterval: (id: number) => clearInterval(id),
};

/* -------------------------------------------------------------- the vault ---- */

const BODY = (subject: string) =>
	`${subject}. ${"A paragraph long enough that the shared chunker keeps it as a chunk. ".repeat(3)}`;

const NOTES = [
	{ path: "crdt.md", subject: "We dropped the CRDT plan", mtime: ago(400) },
	{ path: "storage.md", subject: "The storage layer and its rejected designs", mtime: ago(380) },
	{ path: "taxes.md", subject: "Quarterly taxes and the receipts", mtime: ago(300) },
	{ path: "lunch.md", subject: "Where to get lunch near the office", mtime: ago(250) },
];

// REAL stub TFiles, not plain objects shaped like them: the semantic layer narrows every file
// it reads with `instanceof TFile` before handing it to `cachedRead`, exactly as the shipped
// code must, and a duck-typed fixture would silently read nothing and "pass" against a Pro
// feature that found no topics because it never opened a single note.
const files = NOTES.map((note) => {
	const file = new TFile();
	file.path = note.path;
	file.basename = note.path.replace(/\.md$/, "");
	file.extension = "md";
	file.stat = { mtime: note.mtime, ctime: note.mtime };
	return file;
});

const app = {
	vault: {
		configDir: ".obsidian",
		getMarkdownFiles: () => files,
		getFileByPath: (path: string) => files.find((f) => f.path === path) ?? null,
		cachedRead: async (file: { path: string }) =>
			BODY(NOTES.find((n) => n.path === file.path)?.subject ?? ""),
		on: () => ({}),
	},
	metadataCache: { resolvedLinks: {}, getFileCache: () => null, on: () => ({}) },
	workspace: {
		getActiveViewOfType: () => null,
		getLeavesOfType: () => [],
		getRightLeaf: () => null,
		revealLeaf: () => undefined,
		on: () => ({}),
	},
};

/* ------------------------------------------------------------- the engine ---- */

class FakeEngine {
	desktop = true;
	state = "running";
	installed = false;
	readonly calls: string[] = [];
	private nextId = 1;

	hits: Record<string, Array<{ note: string; score: number }>> = {
		"crdt.md": [{ note: "storage.md", score: 0.83 }],
		"storage.md": [{ note: "crdt.md", score: 0.83 }],
		"taxes.md": [],
		"lunch.md": [],
	};

	async status() {
		return { state: this.state, expectedVersion: "1.0.0", installed: null, updateAvailable: false, byoPath: false, health: null };
	}
	async ensureStarted() {
		return this.state === "not-installed"
			? null
			: { ok: true, version: "1.0.0", engine: "onnx", model: "all-MiniLM-L6-v2", dim: 384, pid: 1, vault: null, chunks: 0 };
	}
	plan() {
		return {
			target: "win-x64",
			version: "1.0.0",
			tag: "sidecar-v1.0.0",
			assetName: "embed-sidecar-win-x64.zip",
			url: "https://github.com/israerusan/second-read-engine/releases/download/sidecar-v1.0.0/embed-sidecar-win-x64.zip",
			sha256: "4f1c".padEnd(64, "0"),
			executable: "embed-sidecar.exe",
		};
	}
	planError() {
		return null;
	}
	vaultKey() {
		return "cafebabecafebabe";
	}
	async cancel() {
		/* nothing in flight in these tests */
	}
	/** EngineHost's, called by saveSettings() — the BYO path is per-plugin on the shared host. */
	updateSettings() {
		/* no-op */
	}
	async install() {
		this.installed = true;
		this.state = "running";
		return { ok: true, version: "1.0.0", engine: "onnx", model: "all-MiniLM-L6-v2", dim: 384, pid: 1, vault: null, chunks: 0 };
	}
	async request(method: string, params?: unknown, options?: { onRequestId?: (id: number) => void }) {
		options?.onRequestId?.(this.nextId++);
		this.calls.push(method);
		if (method !== "query") return {};
		const texts = ((params as { texts?: string[] }).texts ?? []) as string[];
		return {
			results: texts.map((text, i) => ({
				i,
				hits: (this.hits[owner(text)] ?? []).map((hit) => ({ key: "k", note: hit.note, ord: 0, score: hit.score, preview: "" })),
			})),
		};
	}
}

function owner(text: string): string {
	for (const note of NOTES) {
		const first = chunkNote(BODY(note.subject))[0];
		if (first && text.includes(first.text.slice(0, 30))) return note.path;
	}
	return "";
}

/* --------------------------------------------------------------- the plugin -- */

async function makePlugin(isPro: boolean, engine: FakeEngine | null): Promise<PatinaPlugin> {
	const plugin = new PatinaPlugin(app as never, { id: "patina", version: "1.0.0" } as never);
	(plugin as unknown as { data: unknown }).data = { isPro, queueMinScore: 0 };
	await plugin.loadSettings();
	// isPro is recomputed from the signed key on load — a data.json that just SAYS isPro:true is
	// not Pro (that is asserted in license.test.mjs). These tests are about what a REAL Pro user
	// gets, so the entitlement is set here, after the verifier has had its say.
	plugin.settings.isPro = isPro;
	plugin.settings.queueMinScore = 0;
	plugin.engine = engine as never;
	plugin.index.rebuild(plugin.settings, NOW);
	return plugin;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function main(): Promise<void> {
	// --- 1. PRO + engine: the queue is really grouped ------------------------------
	{
		const engine = new FakeEngine();
		const plugin = await makePlugin(true, engine);

		await plugin.groupQueueByTopic();

		assert.ok(plugin.topics, "Pro + an engine produces a grouping — this is what the $29 buys");
		assert.equal(plugin.topics.groups.length, 1, "crdt~storage is one topic");
		assert.deepEqual(
			plugin.topics.groups[0].members.map((m) => m.path),
			["crdt.md", "storage.md"]
		);
		assert.ok(engine.calls.includes("upsert"), "the vault was indexed through the shared engine");
		assert.ok(engine.calls.includes("query"), "…and queried");

		// The VIEW renders it. A grouping the sidebar ignores is a grouping that does not exist.
		const view = new DecayQueueView({} as never, plugin);
		view.render();
		const el = view.contentEl as unknown as FakeEl;
		const text = el.text();
		assert.match(text, /storage/, "the topic is named after its most central note");
		assert.match(text, /2 notes · 83% alike/, "…and says how big it is and how alike it is");
		assert.match(text, /No shared topic/, "the loners get their own section");
		assert.match(text, /Ungroup/, "…and the header offers the way back to the flat list");

		// NO NOTE IS LOST. Grouping a worklist that silently drops half of it is not a feature.
		const rowTitles = el
			.findAll((node) => node.classes.has("patina-row-title"))
			.map((node) => node.textContent)
			.sort();
		assert.deepEqual(rowTitles, ["crdt", "lunch", "storage", "taxes"]);
	}

	// --- 2. NO ENGINE: say why, and offer to install it ----------------------------
	{
		openedModals.length = 0;
		Setting.reset();
		const engine = new FakeEngine();
		engine.state = "not-installed";
		const plugin = await makePlugin(true, engine);

		await plugin.groupQueueByTopic();

		assert.equal(plugin.topics, null, "no engine ⇒ no grouping…");
		const block = openedModals.at(-1);
		assert.ok(block, "…and a modal that says why. NOT an empty queue, which reads as 'no topics'.");
		const blockText = (block.contentEl as unknown as FakeEl).text();
		assert.match(blockText, /not installed yet/);
		assert.match(blockText, /never sends anything over the network/);
		assert.ok(
			!/no topic|nothing found|0 notes/i.test(blockText),
			"a feature that did not RUN must never report a finding"
		);
		assert.equal(engine.installed, false, "and nothing has been downloaded");

		// The consent gate. Pressing "Set up the engine" opens the SHARED EngineInstallModal —
		// which names the URL, the version, the checksum and the install path, and downloads
		// NOTHING until its own confirm button is pressed.
		const setup = Setting.instances.flatMap((s) => s.buttons).find((b) => b.label === "Set up the engine");
		assert.ok(setup, "the block modal offers the install");
		setup.press();

		const consent = openedModals.at(-1);
		assert.ok(consent && consent !== block, "…by opening the consent modal");
		const consentText = (consent.contentEl as unknown as FakeEl).text() + (consent.titleEl as unknown as FakeEl).text();
		assert.match(consentText, /will download a program and run it on your computer/);
		assert.match(consentText, /https:\/\/github\.com\/israerusan\/second-read-engine\/releases\/download\//);
		assert.match(consentText, /4f1c0{60}/, "the SHA-256 it will be checked against");
		assert.match(consentText, /second-read-engine\\bin\\1\.0\.0/, "…and where it lands: OUTSIDE the vault");
		assert.equal(engine.installed, false, "opening the modal downloads nothing");

		// Only NOW.
		const confirm = Setting.instances.flatMap((s) => s.buttons).find((b) => b.label === "Download and run");
		assert.ok(confirm, "the consent modal has exactly one way to proceed");
		confirm.press();
		await tick();
		await tick();
		assert.equal(engine.installed, true, "the download happens on the explicit click, and only there");
		assert.ok(notices.some((n) => /Engine ready/.test(n)));
	}

	// --- 3. FREE: the engine is never touched -------------------------------------
	{
		const engine = new FakeEngine();
		const plugin = await makePlugin(false, engine);

		await plugin.groupQueueByTopic();
		await plugin.findSuperseded();

		assert.equal(plugin.topics, null);
		assert.equal(engine.calls.length, 0, "a free user's click reaches no engine, embeds nothing, starts nothing");
	}

	// --- 4. losing Pro drops the Pro view -----------------------------------------
	// A key that stops verifying (revoked, expired, a bad paste over a good one) must not leave
	// the queue stuck in a Pro view the user can no longer regenerate.
	{
		const engine = new FakeEngine();
		const plugin = await makePlugin(true, engine);
		await plugin.groupQueueByTopic();
		assert.ok(plugin.topics);

		plugin.settings.licenseKey = "not-a-key";
		await plugin.refreshLicense();
		assert.equal(plugin.settings.isPro, false);
		assert.equal(plugin.topics, null, "the Pro-only view goes when Pro goes");
	}
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
