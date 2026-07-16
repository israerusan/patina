import { App, Modal, Notice } from "obsidian";
import {
	PRO_NAME,
	PRO_PRICE_LABEL,
	PRO_TAGLINE,
	PRO_UPSELL,
	PRODUCT_NAME,
	PURCHASE_AVAILABLE,
} from "../../product";
import { renderPurchaseCta } from "../links";

/**
 * Shown the moment a free user reaches for a Pro feature: what they get, the price, and a
 * shortcut to paste a key — instead of a toast that fades with no next step.
 *
 * The CTA is `renderPurchaseCta`, which renders a buy button ONLY when a checkout exists. It
 * does not today (product.ts: PURCHASE_URL is null), so this modal says "purchasing opens
 * soon" and sells nothing. That is deliberate: the previous version of this file rendered a
 * "Get Pro — $29 one-time" button pointing at a generic tip-jar page that delivers no key.
 *
 * Built with createDiv/createEl only. Never innerHTML: the review bot rejects it, and the copy
 * here is interpolated from product.ts, which is exactly the shape of string that turns into an
 * injection the day someone makes it configurable.
 */
export class ProUpsellModal extends Modal {
	constructor(
		app: App,
		private feature: keyof typeof PRO_UPSELL
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(`${PRO_NAME} — ${PRO_PRICE_LABEL}`);

		contentEl.createDiv({
			cls: "patina-upsell-lead",
			text: PRO_UPSELL[this.feature] ?? PRO_TAGLINE,
		});
		contentEl.createDiv({ cls: "patina-upsell-sub", text: PRO_TAGLINE });

		const actions = contentEl.createDiv({ cls: "patina-upsell-actions" });
		renderPurchaseCta(actions, {
			label: `Get Pro — ${PRO_PRICE_LABEL}`,
			cls: "patina-pro-btn",
		});

		// Modal is not a Component, so there is no registerDomEvent here. onClose() empties
		// contentEl, which takes the button and this listener with it.
		//
		// The key entry point stays available even with no checkout: an early customer who was
		// sent a key by hand still has to be able to use it.
		const haveKey = actions.createEl("button", {
			text: PURCHASE_AVAILABLE ? "I have a license key" : "I already have a key",
		});
		haveKey.addEventListener("click", () => {
			this.close();
			// A plain instruction rather than a private-API jump into the settings pane.
			new Notice(`Open Settings → Community plugins → ${PRODUCT_NAME} → License and paste your key.`);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
