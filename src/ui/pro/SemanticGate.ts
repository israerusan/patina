import { Modal, Setting, type App } from "obsidian";
import { EngineInstallModal } from "../../shared/engine/EngineInstallModal";
import { blockCopy } from "../../core/engineCopy.mjs";
import type { SemanticBlock } from "../../semantic";
import type { PRO_UPSELL } from "../../product";
import { ProUpsellModal } from "./ProUpsellModal";

/**
 * What happens when a semantic Pro feature CANNOT run.
 *
 * This is the honest-degradation surface, and it has exactly one job: never let "the engine is
 * not here" look like "there is nothing to find". A sidebar that renders an empty list, or a
 * toast that says "no results", is indistinguishable from a clean vault — so a blocked feature
 * opens THIS instead, which says which of the five things went wrong and, when the answer is
 * "the engine is not installed", offers to install it.
 *
 * The install offer routes through the SHARED EngineInstallModal — the consent gate. Nothing is
 * downloaded, extracted, made executable or run until the user clicks "Download and run" in it.
 * `installEngine()` below is that click's handler and has no other caller.
 */
export interface SemanticGateHost {
	readonly app: App;
	/** Download + verify + extract + start. Called ONLY from the consent modal's confirm. */
	installEngine(): void;
}

export function showSemanticBlock(
	host: SemanticGateHost,
	block: SemanticBlock,
	feature: string,
	upsell: keyof typeof PRO_UPSELL
): void {
	// A newer run superseded this one — the user asked for the newer answer, and they are about
	// to get it. Saying anything here would be noise about our own bookkeeping.
	if (block.kind === "cancelled") return;

	// A free user reaching for a Pro feature gets the Pro pitch, not an engine lecture. They do
	// not have an engine problem; they have a paywall, and telling them about ONNX would be a
	// non-sequitur.
	if (block.kind === "not-pro") {
		new ProUpsellModal(host.app, upsell).open();
		return;
	}

	new SemanticBlockModal(host, block, feature).open();
}

class SemanticBlockModal extends Modal {
	constructor(
		private readonly host: SemanticGateHost,
		private readonly block: SemanticBlock,
		private readonly feature: string
	) {
		super(host.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(this.feature);

		contentEl.addClass("note-decay-block");
		contentEl.createEl("p", {
			cls: "note-decay-block-copy",
			text: blockCopy(this.block, this.feature),
		});

		// The one state with something to DO about it. Everything else is information: a phone is
		// a phone, an unpublished engine is unpublished, and a broken install is a support issue.
		if (this.block.kind === "not-installed") {
			const plan = this.block.plan;
			const installDir = this.block.installDir;
			new Setting(contentEl)
				.addButton((button) =>
					button.setButtonText("Not now").onClick(() => {
						this.close();
					})
				)
				.addButton((button) =>
					button
						.setButtonText("Set up the engine")
						.setCta()
						.onClick(() => {
							this.close();
							new EngineInstallModal(this.host.app, {
								plan,
								installDir,
								downloadSizeLabel: "about 45 MB (about 100 MB on disk)",
								onConfirm: () => this.host.installEngine(),
							}).open();
						})
				);
			return;
		}

		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Close").setCta().onClick(() => {
				this.close();
			})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
