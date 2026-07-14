import { MarkdownView, Notice, TFile } from "obsidian";
import type NoteDecayPlugin from "./main";
import { ProfileSuggestModal } from "./ui/ProfileSuggestModal";

/**
 * Every command, in one place.
 *
 * These used to live inline in onload(), which is how a plugin entry point turns into a
 * god-object. main.ts now says what the plugin IS; this says what it DOES.
 *
 * Sentence case, no plugin name in the name (the review rejects "Note Decay: open queue"),
 * no default hotkeys (the guidelines forbid them and the review checks).
 *
 * The two Pro commands use checkCallback and return FALSE when the user is not Pro or the
 * engine is not available — so they are HIDDEN from the palette rather than present and
 * always failing with a sales Notice. A command that can only ever show an ad is not a
 * command.
 */
export function registerCommands(plugin: NoteDecayPlugin): void {
	plugin.addCommand({
		id: "open-review-queue",
		name: "Open review queue",
		callback: () => {
			void plugin.activateQueue();
		},
	});

	plugin.addCommand({
		id: "score-active-note",
		name: "Show decay score for this note",
		checkCallback: (checking) => {
			const file = activeMarkdown(plugin);
			if (!file) return false;
			if (!checking) plugin.explainScore(file.path);
			return true;
		},
	});

	plugin.addCommand({
		id: "snooze-active-note",
		name: "Snooze this note",
		checkCallback: (checking) => {
			const file = activeMarkdown(plugin);
			if (!file) return false;
			if (!checking) void plugin.snooze(file.path);
			return true;
		},
	});

	plugin.addCommand({
		id: "set-decay-profile",
		name: "Set decay profile for this note",
		checkCallback: (checking) => {
			const file = activeMarkdown(plugin);
			if (!file) return false;
			if (!checking) {
				new ProfileSuggestModal(plugin.app, (profile) => {
					void plugin.setProfile(file, profile.id);
				}).open();
			}
			return true;
		},
	});

	plugin.addCommand({
		id: "export-decay-csv",
		name: "Export decay scores as CSV",
		callback: () => {
			void plugin.exportCsv();
		},
	});

	plugin.addCommand({
		id: "group-queue-by-topic",
		name: "Group the review queue by topic",
		checkCallback: (checking) => {
			if (!plugin.canUseSemanticPro()) return false;
			if (!checking) plugin.groupQueueByTopic();
			return true;
		},
	});
}

function activeMarkdown(plugin: NoteDecayPlugin): TFile | null {
	const file = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
	return file instanceof TFile && file.extension === "md" ? file : null;
}

/** Notices live here too, so the plugin body stays free of copy. */
export function noticeSnoozed(title: string, days: number): void {
	new Notice(`"${title}" is snoozed for ${days} day${days === 1 ? "" : "s"}.`);
}

export function noticeProfile(title: string, profile: string): void {
	new Notice(`"${title}" now decays on the ${profile} profile.`);
}
