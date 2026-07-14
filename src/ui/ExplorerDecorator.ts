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
 * THE FRAGILITY, STATED PLAINLY. Obsidian's file explorer is virtualized: rows are created
 * and destroyed as you scroll, and there is no public API to decorate one. So this walks
 * `.nav-file-title[data-path]` and paints what exists right now, then repaints on a
 * debounced `layout-change` and on a MutationObserver over the explorer container. The
 * selector and the `data-path` attribute are internal DOM, not public API: if a future
 * Obsidian release renames either, the dimming silently stops. It does NOT break anything
 * else — that is the design constraint. Every write is an attribute this plugin owns and
 * removes on unload, so the failure mode is "the feature does nothing", never "the file
 * explorer is broken".
 *
 * The observer is disposed through the owning Component's `register()`, so an unloaded
 * plugin cannot keep a MutationObserver alive against a live DOM tree — the classic leak.
 */
const REPAINT_DEBOUNCE_MS = 150;
const ATTR = "data-decay";

export class ExplorerDecorator {
	private observer: MutationObserver | null = null;
	private repaintTimer: number | null = null;
	private enabled = false;

	constructor(
		private readonly owner: Component,
		private readonly doc: Document,
		private readonly index: DecayIndex
	) {}

	/**
	 * Start watching. Idempotent, and safe to call before the explorer exists — the
	 * observer is attached to the workspace container, so a file explorer opened later is
	 * picked up by the same mutation stream.
	 */
	start(): void {
		if (this.observer) return;
		const root = this.doc.body;
		if (!root) return;

		const observer = new MutationObserver(() => this.schedule());
		observer.observe(root, { childList: true, subtree: true });
		this.observer = observer;
		// The register() is what makes the leak impossible: Obsidian calls it on unload even
		// if the plugin throws on the way out.
		this.owner.register(() => this.stop());
	}

	stop(): void {
		this.cancelTimer();
		this.observer?.disconnect();
		this.observer = null;
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

	/** Paint every row currently in the DOM. Cheap: a Map lookup and an attribute write. */
	paint(): void {
		if (!this.enabled) return;
		for (const el of this.rows()) {
			const path = el.getAttribute("data-path");
			if (!path) continue;
			const row = this.index.get(path);
			// `exempt` (evergreen or snoozed) and `fresh` carry no attribute at all, rather than
			// a "fresh" one: an attribute nobody styles is still an attribute a theme's CSS can
			// trip over, and the absence is the honest encoding of "nothing to say".
			if (!row || row.band === "exempt" || row.band === "fresh") {
				el.removeAttribute(ATTR);
				continue;
			}
			if (el.getAttribute(ATTR) !== row.band) el.setAttribute(ATTR, row.band);
		}
	}

	/** Remove every attribute this decorator ever set. Called on unload and on disable. */
	clear(): void {
		for (const el of this.rows()) el.removeAttribute(ATTR);
	}

	private rows(): HTMLElement[] {
		return Array.from(this.doc.querySelectorAll<HTMLElement>(".nav-file-title[data-path]"));
	}

	private cancelTimer(): void {
		if (this.repaintTimer === null) return;
		window.clearTimeout(this.repaintTimer);
		this.repaintTimer = null;
	}
}
