import { PURCHASE_AVAILABLE, PURCHASE_PENDING_COPY, PURCHASE_PENDING_LABEL, PURCHASE_URL } from "../product";

/** The URL if it is a well-formed http(s) URL, otherwise null. Never a `javascript:` href. */
export function safeHttpUrl(url: string | null | undefined): string | null {
	if (typeof url !== "string" || url.length === 0) return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
	} catch {
		// Not a parseable URL.
	}
	return null;
}

/**
 * Every outbound link goes through here: the href is sanitised to http(s) (so a value that
 * ever became user-editable could not smuggle in `javascript:`), and it opens in a new tab
 * with rel="noopener noreferrer".
 *
 * An ANCHOR, deliberately — not `window.open`. Obsidian routes a real anchor to the OS
 * browser on desktop AND on mobile; `window.open` does not, and a Pro link that silently
 * does nothing on a phone is worse than no link.
 *
 * Returns null — and renders NOTHING — when the URL is not usable. There is no fallback href,
 * because the only fallback anyone would reach for is the purchase URL, and that is exactly
 * the value that is allowed to be missing.
 */
export function createExternalLink(
	parent: HTMLElement,
	options: { text: string; url: string | null | undefined; cls?: string }
): HTMLAnchorElement | null {
	const href = safeHttpUrl(options.url);
	if (!href) return null;
	const link = parent.createEl("a", { cls: options.cls, text: options.text, href });
	link.setAttr("target", "_blank");
	link.setAttr("rel", "noopener noreferrer");
	return link;
}

/**
 * THE ONE PLACE A PURCHASE CTA IS RENDERED — settings card, upsell modal, inline upgrade link.
 *
 * While `PURCHASE_URL` is null there is no checkout to send anyone to, so this renders the
 * truth instead of a button: a user who clicks "Unlock Pro" and lands on a generic tip-jar page
 * has been sold nothing, and a user who PAYS there has been sold nothing twice. The feature
 * list above it still renders — the point of the card is to say what Pro is, and that is true
 * whether or not it is on sale today.
 *
 * @returns true when a real buy link was rendered.
 */
export function renderPurchaseCta(
	parent: HTMLElement,
	options: { label: string; cls?: string; pendingCls?: string }
): boolean {
	if (PURCHASE_AVAILABLE) {
		return createExternalLink(parent, { text: options.label, url: PURCHASE_URL, cls: options.cls }) !== null;
	}
	const pending = parent.createDiv({ cls: options.pendingCls ?? "patina-pro-pending" });
	pending.createSpan({ cls: "patina-pro-pending-label", text: PURCHASE_PENDING_LABEL });
	pending.createSpan({ cls: "patina-pro-pending-copy", text: PURCHASE_PENDING_COPY });
	return false;
}
