// The explorer decorator watches the EXPLORER, not the document.
//
// THE BUG THIS LOCKS OUT. `observer.observe(doc.body, { childList: true, subtree: true })`.
// Obsidian rewrites the editor's DOM on essentially every keystroke, so a body-wide subtree
// observer fires continuously while the user is typing a note — a surface this plugin does not
// decorate, does not read, and has no reason to hear about. Each burst schedules a 150 ms
// repaint that runs `querySelectorAll(".nav-file-title[data-path]")` over the WHOLE document.
// Type a paragraph and the file explorer is repainted hundreds of times. DESIGN 8.1 says "a
// MutationObserver on the explorer container", and the difference is not cosmetic: it is the
// difference between a callback that fires when the explorer changes and one that fires when
// anything anywhere changes.
//
// There is no DOM in Node, so this stands up the three DOM primitives the decorator actually
// touches — MutationObserver, querySelectorAll, get/set/removeAttribute — and asserts on WHAT
// IT WAS HANDED. A fake that recorded nothing would let the old code pass.
import assert from "node:assert";
import { ExplorerDecorator } from "../src/ui/ExplorerDecorator";
import type { DecayIndex } from "../src/decayIndex";
import type { QueueRow } from "../src/core/queue.d.mts";

/* ----------------------------------------------------------------- a fake DOM -- */

class FakeRow {
	attrs = new Map<string, string>();
	constructor(path: string) {
		this.attrs.set("data-path", path);
	}
	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}
	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}
	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}
}

/** A node that can be observed and queried, and remembers being either. */
class FakeNode {
	queries: string[] = [];
	constructor(
		readonly name: string,
		private readonly matches: FakeRow[] = []
	) {}
	querySelectorAll(selector: string): FakeRow[] {
		this.queries.push(selector);
		return this.matches;
	}
	/** So a Document fake answers `doc.body` — the old code observed exactly that. */
	get body(): FakeNode {
		return this;
	}
}

interface Observation {
	target: FakeNode;
	options: MutationObserverInit;
}

const observations: Observation[] = [];
let disconnects = 0;
let fire: (() => void) | null = null;

class FakeMutationObserver {
	constructor(private readonly callback: () => void) {}
	observe(target: FakeNode, options: MutationObserverInit): void {
		observations.push({ target, options });
		fire = () => this.callback();
	}
	disconnect(): void {
		disconnects += 1;
	}
}

const globals = globalThis as Record<string, unknown>;
globals.MutationObserver = FakeMutationObserver;
globals.window = {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: number) => clearTimeout(id),
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 200)); // > REPAINT_DEBOUNCE_MS

/* ------------------------------------------------------------------- fixtures -- */

const row = (path: string, band: string): QueueRow => ({ path, band, score: 90 }) as QueueRow;

function fakeIndex(rows: Record<string, QueueRow | null>): DecayIndex {
	return { get: (path: string) => rows[path] ?? null } as unknown as DecayIndex;
}

/** Obsidian's Component, reduced to the one method the decorator uses. */
function fakeOwner(): { register: (fn: () => void) => void; dispose: () => void } {
	const disposers: Array<() => void> = [];
	return {
		register: (fn: () => void) => disposers.push(fn),
		dispose: () => disposers.forEach((fn) => fn()),
	};
}

async function main(): Promise<void> {
	// --- 1. the observer is attached to the explorer, not to the body ------------
	{
		observations.length = 0;
		const stale = new FakeRow("rotting.md");
		const explorer = new FakeNode(".nav-files-container", [stale]);
		const body = new FakeNode("body", [stale]);
		const doc = body as unknown as Document;

		const decorator = new ExplorerDecorator(
			fakeOwner() as never,
			doc,
			fakeIndex({ "rotting.md": row("rotting.md", "decayed") }),
			() => explorer as unknown as HTMLElement
		);
		decorator.start();
		decorator.setEnabled(true);

		assert.equal(observations.length, 1, "exactly one observer");
		assert.equal(
			observations[0].target.name,
			".nav-files-container",
			"the observer must watch the file explorer's container — on document.body it fires on every keystroke the user types into a note"
		);
		assert.notEqual(observations[0].target.name, "body");

		await tick();
		assert.equal(stale.getAttribute("data-decay"), "decayed", "and the row is still painted");
		assert.deepEqual(
			body.queries,
			[],
			"paint() must not sweep the whole document either — the explorer is the only place rows live"
		);
		assert.ok(explorer.queries.length > 0, "it queries inside the explorer");
	}

	// --- 2. an explorer that does not exist yet is picked up on layout-change ----
	// A cold start, or a user with the sidebar closed: `start()` runs before the leaf is
	// mounted, so an observer attached once and never re-resolved would watch nothing forever.
	{
		observations.length = 0;
		let explorer: FakeNode | null = null;
		const doc = new FakeNode("body") as unknown as Document;

		const decorator = new ExplorerDecorator(
			fakeOwner() as never,
			doc,
			fakeIndex({}),
			() => explorer as unknown as HTMLElement | null
		);
		decorator.start();
		decorator.setEnabled(true);
		assert.equal(observations.length, 0, "nothing to observe, and nothing observed");

		explorer = new FakeNode("late-explorer");
		decorator.onLayoutChange();
		assert.equal(observations.length, 1, "the explorer opened later, and the observer followed it");
		assert.equal(observations[0].target.name, "late-explorer");

		// The same container on the next layout-change is not re-observed.
		decorator.onLayoutChange();
		assert.equal(observations.length, 1, "re-attaching to the same container is a no-op");

		// A DIFFERENT container (the user dragged the explorer to the other sidebar) is.
		const before = disconnects;
		explorer = new FakeNode("moved-explorer");
		decorator.onLayoutChange();
		assert.equal(observations.length, 2);
		assert.equal(observations[1].target.name, "moved-explorer");
		assert.equal(disconnects, before + 1, "and the old observer is disconnected, not leaked");
	}

	// --- 3. unload clears every attribute it ever set, document-wide -------------
	{
		observations.length = 0;
		const orphan = new FakeRow("rotting.md");
		orphan.setAttribute("data-decay", "decayed");
		const explorer = new FakeNode("explorer", []);
		const doc = new FakeNode("body", [orphan]) as unknown as Document;

		const owner = fakeOwner();
		const decorator = new ExplorerDecorator(
			owner as never,
			doc,
			fakeIndex({}),
			() => explorer as unknown as HTMLElement
		);
		decorator.start();
		decorator.setEnabled(true);
		await tick();

		owner.dispose(); // what Obsidian does on unload
		assert.equal(
			orphan.getAttribute("data-decay"),
			null,
			"a row in an explorer we are no longer scoped to must still be cleaned up — a stale data-decay is a dimmed note nobody can un-dim"
		);
	}

	// --- 4. mutations inside the explorer still repaint --------------------------
	{
		observations.length = 0;
		const target = new FakeRow("rotting.md");
		const explorer = new FakeNode("explorer", [target]);
		const doc = new FakeNode("body") as unknown as Document;
		const rows: Record<string, QueueRow | null> = { "rotting.md": null };

		const decorator = new ExplorerDecorator(
			fakeOwner() as never,
			doc,
			fakeIndex(rows),
			() => explorer as unknown as HTMLElement
		);
		decorator.start();
		decorator.setEnabled(true);
		await tick();
		assert.equal(target.getAttribute("data-decay"), null, "an unscored note carries no attribute");

		rows["rotting.md"] = row("rotting.md", "stale");
		fire?.(); // the explorer scrolled and rebuilt its rows
		await tick();
		assert.equal(target.getAttribute("data-decay"), "stale", "the observer's callback still repaints");
	}
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
