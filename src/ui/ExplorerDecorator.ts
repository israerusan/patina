import type { Component } from "obsidian";
import type { DecayIndex } from "../decayIndex";

/**
 * Dims stale notes in the file explorer.
 *
 * HOW, AND WHY IT IS DONE THIS WAY. The plugin sets a data ATTRIBUTE on each row
 * (`data-decay="stale"`); styles.css does the dimming. It does not touch `el.style` — the
 * `no-static-styles-assignment` rule rejects that and this portfolio has been dinged on it
 * before — and it does not inject a `<style>` element, which `no-forbidden-elements`
 * rejects. Attribute in, CSS out. That also means a theme can override the dimming, and a
 * user who hates it gets a clean toggle instead of a fight with specificity.
 *
 * WHAT IT OBSERVES, AND WHY IT MATTERS MORE THAN IT LOOKS. The observer is attached to the
 * file explorer's own container — NOT to `document.body`. Obsidian rewrites the editor's DOM
 * on every keystroke, so a `subtree` observer on the body fires continuously while the user
 * types, and each burst schedules a 150 ms repaint that runs a document-wide
 * `querySelectorAll` over a vault-sized tree. Typing a paragraph should not repaint the file
 * explorer several hundred times. The explorer container mutates when the explorer mutates —
 * a scroll, a rename, a folder toggled — which is exactly, and only, when a repaint is owed.
 *
 * THE FRAGILITY, STATED PLAINLY. Obsidian's file explorer is virtualized: rows are created
 * and destroyed as you scroll, and there is no public API to decorate one. So this walks
 * `.nav-file-title[data-path]` inside the explorer and paints what exists right now. The leaf
 * type ("file-explorer"), the selector and the `data-path` attribute are internal DOM, not
 * public API: if a future Obsidian release renames any of them, the dimming silently stops.
 * It does NOT break anything else — that is the design constraint. Every write is an
 * attribute this plugin owns and removes on unload, so the failure mode is "the feature does
 * nothing", never "the file explorer is broken".
 *
 * The explorer may not exist yet when the plugin loads (a cold start, or a user who has it
 * closed), so `ensureAttached()` is cheap, idempotent, and re-run on every `layout-change` —
 * that is what picks up an explorer opened, closed, or moved to another sidebar later.
 *
 * The observer is disposed through the owning Component's `register()`, so an unloaded
 * plugin cannot keep a MutationObserver alive against a live DOM tree — the classic leak.
 */
const REPAINT_DEBOUNCE_MS = 150;
const ATTR = "data-decay";

export class ExplorerDecorator {
	private observer: MutationObserver | null = null;
	/** The container currently under observation, so a re-attach is a no-op when it has not moved. */
	private root: HTMLElement | null = null;
	private repaintTimer: number | null = null;
	private enabled = false;
	private started = false;

	constructor(
		private readonly owner: Component,
		private readonly doc: Document,
		private readonly index: DecayIndex,
		/** The file explorer's container, or null when no explorer is mounted right now. */
		private readonly resolveRoot: () => HTMLElement | null
	) {}

	/**
	 * Start watching. Idempotent, and safe to call before the explorer exists — it simply
	 * attaches nothing, and the next `layout-change` brings us back.
	 */
	start(): void {
		if (!this.started) {
			this.started = true;
			// The register() is what makes the leak impossible: Obsidian calls it on unload even
			// if the plugin throws on the way out.
			this.owner.register(() => this.stop());
		}
		this.ensureAttached();
	}

	/** Attach to the explorer container, or re-attach when the workspace has replaced it. */
	ensureAttached(): void {
		if (!this.started) return;
		const root = this.resolveRoot();
		if (!root || root === this.root) return;

		this.observer?.disconnect();
		const observer = new MutationObserver(() => this.schedule());
		observer.observe(root, { childList: true, subtree: true });
		this.observer = observer;
		this.root = root;
		this.schedule();
	}

	/** The workspace moved: re-resolve the explorer, then repaint whatever is there now. */
	onLayoutChange(): void {
		this.ensureAttached();
		this.schedule();
	}

	stop(): void {
		this.cancelTimer();
		this.observer?.disconnect();
		this.observer = null;
		this.root = null;
		this.started = false;
		this.clear();
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (enabled) this.schedule();
		else this.clear();
	}

	/** Coalesce a storm of DOM mutations (a scroll repaints dozens of rows) into one pass. */
	schedule(): void {
		if (!this.enabled || this.repaintTimer !== null) return;
		this.repaintTimer = window.setTimeout(() => {
			this.repaintTimer = null;
			this.paint();
		}, REPAINT_DEBOUNCE_MS);
	}

	/** Paint every row currently in the explorer. Cheap: a Map lookup and an attribute write. */
	paint(): void {
		if (!this.enabled) return;
		for (const el of this.rows(this.root)) {
			const path = el.getAttribute("data-path");
			if (!path) continue;
			const row = this.index.get(path);
			// `exempt` (evergreen or snoozed) and `fresh` carry no attribute at all, rather than
			// a "fresh" one: an attribute nobody styles is still an attribute a theme's CSS can
			// trip over, and the absence is the honest encoding of "nothing to say". An EXCLUDED
			// note is not in the index at all, so it lands here too and is left undecorated —
			// which is what "never scored or listed" has to mean in the explorer.
			if (!row || row.band === "exempt" || row.band === "fresh") {
				el.removeAttribute(ATTR);
				continue;
			}
			if (el.getAttribute(ATTR) !== row.band) el.setAttribute(ATTR, row.band);
		}
	}

	/**
	 * Remove every attribute this decorator ever set. Called on unload and on disable.
	 *
	 * Document-wide, unlike `paint()`: rows we decorated may be sitting in an explorer that has
	 * since been detached from the leaf we are tracking, and leaving a `data-decay` behind after
	 * the user switched the dimming off would be a broken promise with no way to undo it.
	 */
	clear(): void {
		for (const el of this.rows(null)) el.removeAttribute(ATTR);
	}

	/** Rows inside `scope`, or in the whole document when there is no explorer to scope to. */
	private rows(scope: HTMLElement | null): HTMLElement[] {
		const within: ParentNode = scope ?? this.doc;
		return Array.from(within.querySelectorAll<HTMLElement>(".nav-file-title[data-path]"));
	}

	private cancelTimer(): void {
		if (this.repaintTimer === null) return;
		window.clearTimeout(this.repaintTimer);
		this.repaintTimer = null;
	}
}
