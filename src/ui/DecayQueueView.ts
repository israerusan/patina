import { ItemView, type WorkspaceLeaf } from "obsidian";
import type NoteDecayPlugin from "../main";
import { buildQueue, QUEUE_SORTS } from "../core/queue.mjs";
import type { QueueRow, QueueSort } from "../core/queue.d.mts";
import { FEATURES } from "../core/features.mjs";
import { needsEngine } from "../shared/featureGates.mjs";
import { requirePro } from "./pro/ProGate";

export const VIEW_TYPE_DECAY_QUEUE = "note-decay-queue";

const SORT_LABELS: Record<QueueSort, string> = {
	score: "Decay score",
	mtime: "Last edited",
	lastOpen: "Last opened",
	effort: "Editing time",
};

/**
 * The review queue: the most decayed notes, ranked, in the right sidebar.
 *
 * "Editing time" is sorted from Effort Index's aggregates in the SHARED signals store. When
 * Effort Index is not installed the column is empty and the sort is inert — no dependency,
 * no error, just a column that fills in for free if the user ever installs the other add-on.
 */
export class DecayQueueView extends ItemView {
	private rows: QueueRow[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: NoteDecayPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DECAY_QUEUE;
	}

	getDisplayText(): string {
		return "Review queue";
	}

	getIcon(): string {
		return "hourglass";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	render(): void {
		const settings = this.plugin.settings;
		this.rows = buildQueue(this.plugin.index.all(), {
			sort: settings.queueSort,
			minScore: settings.queueMinScore,
			excludeFolders: settings.excludeFolders,
		});

		const root = this.contentEl;
		root.empty();
		root.addClass("note-decay-queue");

		this.renderHeader(root);

		if (this.rows.length === 0) {
			root.createDiv({
				cls: "note-decay-empty",
				text: "Nothing is decaying. Every note is inside its half-life, snoozed, or evergreen.",
			});
			return;
		}

		const list = root.createDiv({ cls: "note-decay-list" });
		for (const row of this.rows) this.renderRow(list, row);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "note-decay-queue-header" });

		const sortLabel = header.createEl("label", { cls: "note-decay-sort" });
		sortLabel.createSpan({ text: "Sort by" });
		const select = sortLabel.createEl("select");
		for (const sort of QUEUE_SORTS) {
			const option = select.createEl("option", { text: SORT_LABELS[sort], value: sort });
			if (sort === this.plugin.settings.queueSort) option.selected = true;
		}
		// registerDomEvent, not addEventListener: the view is a Component, so Obsidian tears
		// this listener down with the leaf.
		this.registerDomEvent(select, "change", () => {
			void this.plugin.setQueueSort(select.value as QueueSort);
		});

		// The Pro surface. It is rendered for free users too — a locked row that says what it
		// would do is an honest paywall; a hidden feature is a feature nobody buys. The
		// COMMAND is hidden from the palette instead (see commands.ts), because a palette
		// entry that can only ever fail is noise.
		const topic = header.createEl("button", {
			cls: "note-decay-topic-btn",
			text: FEATURES.topicGroups.label,
		});
		topic.createSpan({ cls: "note-decay-pro-pill", text: "Pro" });
		if (!this.plugin.settings.isPro) topic.addClass("is-locked");
		this.registerDomEvent(topic, "click", () => {
			requirePro({ isPro: this.plugin.settings.isPro, app: this.app }, "topicGroups", () => {
				this.plugin.groupQueueByTopic();
			});
		});
		if (needsEngine(FEATURES, "topicGroups")) {
			topic.setAttr(
				"aria-label",
				"Clusters the queue by topic so one review session covers one subject. Needs the semantic engine (desktop)."
			);
		}
	}

	private renderRow(list: HTMLElement, row: QueueRow): void {
		const item = list.createDiv({ cls: "note-decay-row" });
		item.setAttr("data-decay", row.band);

		const main = item.createDiv({ cls: "note-decay-row-main" });
		const title = main.createEl("a", { cls: "note-decay-row-title", text: row.title });
		title.setAttr("href", "#");
		this.registerDomEvent(title, "click", (event: MouseEvent) => {
			event.preventDefault();
			void this.plugin.openNote(row.path, event);
		});

		const meta = main.createDiv({ cls: "note-decay-row-meta" });
		meta.createSpan({ cls: "note-decay-score", text: String(row.score) });
		meta.createSpan({ cls: "note-decay-band", text: row.band });
		if (row.editMs > 0) {
			meta.createSpan({ cls: "note-decay-effort", text: formatDuration(row.editMs) });
		}

		if (row.reasons.length > 0) {
			item.createDiv({ cls: "note-decay-reasons", text: row.reasons.join(" ") });
		}

		const actions = item.createDiv({ cls: "note-decay-row-actions" });
		const snooze = actions.createEl("button", { text: "Snooze" });
		this.registerDomEvent(snooze, "click", () => {
			void this.plugin.snooze(row.path);
		});
	}
}

/** `2h 14m`. Minutes only below an hour; never "0h 3m", which reads as a bug. */
export function formatDuration(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}
