import { PluginSettingTab, Setting, Notice } from "obsidian";
import type NoteDecayPlugin from "../main";
import { PROFILE_LABELS } from "../settings";
import { renderPurchaseCta } from "./links";
import { EngineInstallModal } from "../shared/engine/EngineInstallModal";
import {
	PRO_NAME,
	PRO_PRICE_LABEL,
	PRO_TAGLINE,
	PRO_UNLOCK_SUMMARY,
	PURCHASE_AVAILABLE,
	SUITE_NAME,
} from "../product";
import { FEATURES } from "../core/features.mjs";
import { proFeatureKeys } from "../shared/featureGates.mjs";
import { engineInstallDir } from "../core/engineCopy.mjs";
import { ENGINE_RELEASE_PINNED, ENGINE_VERSION } from "../shared/engine/engineRelease.mjs";
import type { EngineStatus } from "../shared/engine/EngineHost";

export class NoteDecaySettingTab extends PluginSettingTab {
	constructor(private plugin: NoteDecayPlugin) {
		super(plugin.app, plugin);
	}

	/** Nothing typed into a coalesced control may be lost when the tab closes. */
	hide(): void {
		void this.plugin.flushPendingSave();
	}

	display(): void {
		this.containerEl.empty();
		this.renderLicense();
		this.renderScoring();
		this.renderSurfaces();
		this.renderQueue();
		this.renderPro();
		this.renderEngine();
		this.renderActivityLog();
	}

	// --- gating primitives -----------------------------------------------------

	/** The shared accent "Pro" pill — one affordance for gating, everywhere. */
	private markPro(setting: Setting): void {
		setting.nameEl.createSpan({ cls: "note-decay-pro-pill", text: "Pro" });
	}

	/**
	 * The inline upgrade affordance on a locked row.
	 *
	 * While there is no checkout there is nothing to link to, and a link to a generic tip-jar
	 * page is not an upgrade path — it is a way to take somebody's money and send them nothing.
	 * So the row says where Pro comes from instead, and the Pro card below carries the detail.
	 */
	private appendUpgrade(setting: Setting): void {
		setting.descEl.appendText(" ");
		if (!PURCHASE_AVAILABLE) {
			setting.descEl.createSpan({
				cls: "note-decay-upgrade-inline",
				text: `Included in ${PRO_NAME} — purchasing opens soon.`,
			});
			return;
		}
		renderPurchaseCta(setting.descEl, {
			cls: "note-decay-upgrade-inline",
			label: "Upgrade to Pro",
		});
	}

	/**
	 * A Pro row for a free user shows a disabled lock and a way to upgrade — never an empty
	 * right-hand side, which reads as a rendering bug rather than a paywall.
	 */
	private proRow(name: string, desc: string, render: (setting: Setting) => void): void {
		const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
		this.markPro(setting);
		if (!this.plugin.settings.isPro) {
			setting.settingEl.addClass("note-decay-setting-locked");
			setting.addExtraButton((button) =>
				button.setIcon("lock").setDisabled(true).setTooltip("Pro feature")
			);
			this.appendUpgrade(setting);
			return;
		}
		render(setting);
	}

	// --- License (DESIGN 4.5) ---------------------------------------------------

	private renderLicense(): void {
		new Setting(this.containerEl).setName("License").setHeading();

		new Setting(this.containerEl)
			.setName("License key")
			.setDesc(
				`Verified offline with an Ed25519 signature built into the add-on — no account, no server, no network request. One ${SUITE_NAME} key unlocks Pro in all five add-ons.`
			)
			.addTextArea((text) => {
				text.inputEl.addClass("note-decay-license-input");
				text.inputEl.rows = 3;
				text
					.setPlaceholder("Paste your license key")
					.setValue(this.plugin.settings.licenseKey)
					.onChange((value) => {
						this.plugin.settings.licenseKey = value;
						// Re-verify per keystroke (offline, microseconds) but only rebuild the tab
						// when Pro actually FLIPS — display() empties containerEl, which would
						// destroy the textarea the user is typing into.
						void this.plugin.refreshLicense(true, true).then((flipped) => {
							if (flipped) this.display();
						});
					});
			});

		const status = this.containerEl.createDiv({ cls: "note-decay-license-status" });
		if (this.plugin.settings.isPro) {
			status.addClass("is-pro");
			const email = this.plugin.settings.licenseEmail;
			status.createEl("p", {
				text: `Pro active${email ? ` — ${email}` : ""}. This key also unlocks Standing Questions, Effort Index, Prior Art, and Unwritten.`,
			});
			return;
		}

		if (this.plugin.licenseError) {
			status.createEl("p", { cls: "note-decay-license-error", text: this.plugin.licenseError });
		} else {
			status.createEl("p", {
				text: `Free tier. Pro unlocks ${PRO_UNLOCK_SUMMARY} — and the same key unlocks Pro in all five ${SUITE_NAME} add-ons.`,
			});
		}

		this.renderProCard(status);
	}

	/**
	 * The upgrade card. createDiv/createEl/createSpan only — NEVER innerHTML.
	 *
	 * The title is a styled div, not an <h4>: `no-manual-html-headings` rejects a hand-rolled
	 * heading element, and this is a card inside the License section, not a settings section
	 * of its own — a real `.setHeading()` here would put it in the tab's outline.
	 *
	 * THE CARD STAYS; THE BUY BUTTON DOES NOT — not until a checkout exists. The card's job is
	 * to say what Pro IS, and that is true whether or not it is on sale. `renderPurchaseCta`
	 * decides which of the two it renders, from the single `PURCHASE_URL` constant in
	 * product.ts, and it is the only thing in the add-on allowed to make that decision.
	 */
	private renderProCard(parent: HTMLElement): void {
		const card = parent.createDiv({ cls: "note-decay-pro-card" });
		card.createDiv({ cls: "note-decay-pro-card-title", text: `${PRO_NAME} — ${PRO_PRICE_LABEL}` });
		card.createEl("p", { text: PRO_TAGLINE });

		const list = card.createEl("ul");
		for (const key of proFeatureKeys(FEATURES)) {
			list.createEl("li", { text: FEATURES[key].label });
		}

		renderPurchaseCta(card, { cls: "note-decay-pro-btn", label: "Unlock Pro" });
	}

	// --- Scoring ----------------------------------------------------------------

	private renderScoring(): void {
		new Setting(this.containerEl).setName("Scoring").setHeading();

		new Setting(this.containerEl)
			.setName("Frontmatter key")
			.setDesc("The key a note declares its decay profile under. Change it if it clashes with your own conventions.")
			.addText((text) =>
				text.setValue(this.plugin.settings.frontmatterKey).onChange((value) => {
					this.plugin.settings.frontmatterKey = value.trim() || "decay";
					this.plugin.queueSave();
				})
			);

		new Setting(this.containerEl)
			.setName("Default profile")
			.setDesc("Used for every note that does not name one — and for a note whose profile is a typo.")
			.addDropdown((dropdown) => {
				for (const profile of PROFILE_LABELS) dropdown.addOption(profile.id, profile.name);
				dropdown.setValue(this.plugin.settings.defaultProfile).onChange(async (value) => {
					this.plugin.settings.defaultProfile = value;
					await this.plugin.saveSettings();
				});
			});

		for (const profile of PROFILE_LABELS) {
			if (profile.id === "evergreen") continue; // A zero half-life IS "evergreen". Nothing to tune.
			new Setting(this.containerEl)
				.setName(`${profile.name} half-life`)
				.setDesc(`${profile.desc} Days before a signal counts for half as much.`)
				.addSlider((slider) =>
					slider
						.setLimits(1, 365, 1)
						.setValue(this.plugin.settings.halfLives[profile.id] ?? 90)
						.setDynamicTooltip()
						.onChange((value) => {
							this.plugin.settings.halfLives[profile.id] = value;
							// A slider fires once per step; coalesce the whole drag into one save.
							this.plugin.queueSave();
						})
				);
		}

		const weights: Array<{ key: "mtime" | "open" | "inbound"; name: string; desc: string }> = [
			{ key: "mtime", name: "Weight: last edited", desc: "How much an old edit counts toward decay." },
			{ key: "open", name: "Weight: last opened", desc: "How much not reading a note counts toward decay." },
			{
				key: "inbound",
				name: "Weight: inbound links",
				desc: "How much a stale inbound link counts. A note with NO inbound links is never punished for it — the weights renormalize over the signals that exist.",
			},
		];
		for (const weight of weights) {
			new Setting(this.containerEl)
				.setName(weight.name)
				.setDesc(weight.desc)
				.addSlider((slider) =>
					slider
						.setLimits(0, 1, 0.05)
						.setValue(this.plugin.settings.weights[weight.key])
						.setDynamicTooltip()
						.onChange((value) => {
							this.plugin.settings.weights[weight.key] = value;
							this.plugin.queueSave();
						})
				);
		}
	}

	// --- Surfaces ---------------------------------------------------------------

	private renderSurfaces(): void {
		new Setting(this.containerEl).setName("Surfaces").setHeading();

		new Setting(this.containerEl)
			.setName("Dim stale notes in the file list")
			.setDesc(
				"Fades decaying notes in the file explorer. This decorates Obsidian's own file list, which has no public API for it — if a future release changes the file explorer, the dimming stops and nothing else does."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.dimInExplorer).onChange(async (value) => {
					this.plugin.settings.dimInExplorer = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(this.containerEl)
			.setName("Show the score in the status bar")
			.setDesc("The active note's decay score and band.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
					this.plugin.settings.showStatusBar = value;
					await this.plugin.saveSettings();
				})
			);
	}

	// --- Queue ------------------------------------------------------------------

	private renderQueue(): void {
		new Setting(this.containerEl).setName("Review queue").setHeading();

		new Setting(this.containerEl)
			.setName("Minimum score")
			.setDesc("Notes below this score stay out of the queue.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 99, 1)
					.setValue(this.plugin.settings.queueMinScore)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.queueMinScore = value;
						this.plugin.queueSave();
					})
			);

		new Setting(this.containerEl)
			.setName("Snooze length")
			.setDesc("Days a snoozed note stays out of the queue.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 180, 1)
					.setValue(this.plugin.settings.snoozeDays)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.snoozeDays = value;
						this.plugin.queueSave();
					})
			);

		new Setting(this.containerEl)
			.setName("Excluded folders")
			.setDesc("One per line. Notes in these folders are never scored or listed.")
			.addTextArea((text) => {
				text.inputEl.rows = 3;
				text
					.setPlaceholder("Archive\nTemplates")
					.setValue(this.plugin.settings.excludeFolders.join("\n"))
					.onChange((value) => {
						this.plugin.settings.excludeFolders = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line !== "");
						this.plugin.queueSave();
					});
			});

		const snoozed = Object.entries(this.plugin.settings.snoozedUntil).filter(
			([, until]) => until > Date.now()
		);
		if (snoozed.length > 0) {
			new Setting(this.containerEl)
				.setName("Snoozed notes")
				.setDesc(`${snoozed.length} note${snoozed.length === 1 ? "" : "s"} are snoozed.`)
				.addButton((button) =>
					button.setButtonText("Wake all").onClick(async () => {
						this.plugin.settings.snoozedUntil = {};
						await this.plugin.saveSettings();
						this.display();
					})
				);
		}
	}

	// --- Pro --------------------------------------------------------------------

	private renderPro(): void {
		const heading = new Setting(this.containerEl).setName("Pro features").setHeading();
		this.markPro(heading);

		this.proRow(
			FEATURES.topicGroups.label,
			"Clusters the review queue by topic so one session covers one subject. Needs the semantic engine, which runs on your computer and never sends anything over the network.",
			(setting) => {
				setting.addButton((button) =>
					button.setButtonText("Group the queue").onClick(async () => {
						button.setDisabled(true);
						try {
							await this.plugin.groupQueueByTopic();
						} finally {
							button.setDisabled(false);
						}
					})
				);
			}
		);

		this.proRow(
			FEATURES.superseded.label,
			"Flags a stale note whose content is now largely covered by NEWER notes — the ones you rewrote without noticing. Needs the semantic engine.",
			(setting) => {
				setting.addButton((button) =>
					button.setButtonText("Find superseded notes").onClick(async () => {
						button.setDisabled(true);
						try {
							await this.plugin.findSuperseded();
						} finally {
							button.setDisabled(false);
						}
					})
				);
			}
		);
	}

	// --- Semantic engine (DESIGN 7.2) -------------------------------------------

	private renderEngine(): void {
		new Setting(this.containerEl).setName("Semantic engine").setHeading();

		const host = this.plugin.engine;
		const box = this.containerEl.createDiv({ cls: "note-decay-engine" });

		if (!host || !host.desktop) {
			box.createEl("p", {
				text: "The semantic engine runs on desktop only. Everything else in this add-on works here.",
			});
			return;
		}

		box.createEl("p", {
			text: "Pro features that compare notes by meaning need a local engine — a self-contained program that runs on your computer and never sends anything over the network. It is about 45 MB to download and 100 MB on disk.",
		});

		// The button is INERT until the engine release is pinned, and the reason is not a policy
		// choice — it is that there is no SHA-256 to verify a download against, and EngineHost
		// refuses (UnpinnedReleaseError) to fetch an executable it cannot checksum. Showing an
		// enabled button that always fails would be worse than showing the truth.
		//
		// When it IS pinned, this opens the SHARED EngineInstallModal — the consent gate — and
		// that modal's confirm handler is the only caller of install() in the add-on. Nothing is
		// downloaded, extracted, chmod-ed or run before that click.
		const plan = host.plan();
		new Setting(box)
			.setName("Download engine")
			.setDesc(
				ENGINE_RELEASE_PINNED && plan
					? `Downloads engine ${ENGINE_VERSION}, verifies its SHA-256, and runs it. You will be shown the exact URL, version, checksum, and install path before anything is downloaded.`
					: !ENGINE_RELEASE_PINNED
						? "The engine build is not published for this release yet. Semantic Pro features stay off until it is; everything else in this add-on works now."
						: (host.planError() ??
							"There is no engine build for this computer. Point the add-on at one you built yourself, below.")
			)
			.addButton((button) => {
				button.setButtonText("Download engine");
				if (!ENGINE_RELEASE_PINNED || !plan) {
					button.setDisabled(true);
					button.setTooltip(
						ENGINE_RELEASE_PINNED
							? "No engine build for this computer."
							: "Not available in this release."
					);
					return;
				}
				button.onClick(() => {
					new EngineInstallModal(this.app, {
						plan,
						installDir: engineInstallDir(plan.target, plan.version),
						downloadSizeLabel: "about 45 MB (about 100 MB on disk)",
						onConfirm: () => this.plugin.installEngine(),
					}).open();
				});
			});

		new Setting(box)
			.setName("Path to an existing engine")
			.setDesc(
				"Absolute path to an engine binary you already have. When set, nothing is ever downloaded — this is the fallback for any system that refuses to run a downloaded executable."
			)
			.addText((text) =>
				text
					.setPlaceholder("/path/to/embed-sidecar")
					.setValue(this.plugin.settings.enginePath)
					.onChange((value) => {
						this.plugin.settings.enginePath = value.trim();
						this.plugin.queueSave();
					})
			);

		new Setting(box)
			.setName("Test engine")
			.setDesc("Starts the engine and asks it for its version. Nothing is downloaded.")
			.addButton((button) =>
				button.setButtonText("Test engine").onClick(async () => {
					button.setDisabled(true);
					try {
						const status: EngineStatus = await this.plugin.testEngine();
						new Notice(
							status.health
								? `Engine ready — ${status.health.model}, ${status.health.dim}-dim.`
								: `Engine ${status.state}. ${status.error ?? "No engine is installed."}`
						);
					} finally {
						button.setDisabled(false);
					}
				})
			);
	}

	// --- Activity log (the §5 disclosure, made actionable) -----------------------

	private renderActivityLog(): void {
		new Setting(this.containerEl).setName("Activity log").setHeading();

		new Setting(this.containerEl)
			.setName("Clear activity log")
			.setDesc(
				`This add-on records, on your device only, which notes you open. The log lives in ${this.app.vault.configDir}/second-read/signals/ and never leaves your machine. Clearing it resets every "last opened" and every score that depends on one.`
			)
			.addButton((button) =>
				button
					.setButtonText("Clear activity log")
					.setWarning()
					.onClick(async () => {
						await this.plugin.clearActivityLog();
						new Notice("Activity log cleared.");
					})
			);
	}
}
