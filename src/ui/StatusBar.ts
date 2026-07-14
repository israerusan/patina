import type { DecayScore } from "../core/decay.d.mts";

/**
 * The active note's decay score in the status bar: `Decay 72 · stale`.
 *
 * Owns its own element and its own emptiness rules, so main.ts does not have to know that
 * a non-markdown view, an exempt note, and a disabled setting all render as nothing.
 * The band is carried as a data attribute, never as an inline style — `el.style.x = ...`
 * is what the `no-static-styles-assignment` rule rejects, and this plugin has to be
 * spotless on that rule because it also sets one on every file-explorer row.
 */
export class StatusBar {
	constructor(private el: HTMLElement) {
		this.el.addClass("note-decay-status");
	}

	get element(): HTMLElement {
		return this.el;
	}

	render(score: DecayScore | null, enabled: boolean): void {
		this.el.empty();
		this.el.removeAttribute("aria-label");
		this.el.removeAttribute("data-decay");
		if (!enabled || !score || score.band === "exempt") return;

		this.el.setText(`Decay ${score.score} · ${score.band}`);
		this.el.setAttr("data-decay", score.band);
		const why = score.reasons.length > 0 ? ` ${score.reasons.join(" ")}` : "";
		this.el.setAttr("aria-label", `Decay score ${score.score} of 100, ${score.band}.${why}`);
	}
}
