import { ItemView, type WorkspaceLeaf } from "obsidian";
import type PatinaPlugin from "../main";
import { buildQueue, QUEUE_SORTS } from "../core/queue.mjs";
import type { QueueRow, QueueSort } from "../core/queue.d.mts";
import type { TopicGroup } from "../core/topics.d.mts";
import { EMPTY_TOPIC_GROUPS } from "../core/engineCopy.mjs";
import { FEATURES } from "../core/features.mjs";
import { requirePro } from "./pro/ProGate";

export const VIEW_TYPE_DECAY_QUEUE = "patina-queue";

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
 *
 * PRO: when `plugin.topics` holds a grouping, the flat list is replaced by topic sections —
 * one review session, one subject (DESIGN 8.1). The grouping is computed by the semantic
 * engine and handed here; this view never talks to the engine and never decides whether the
 * user is entitled to it. It renders whatever it is given, including nothing.
 */
export class DecayQueueView extends ItemView {
	private rows: QueueRow[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PatinaPlugin
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
		root.addClass("patina-queue");

		this.renderHeader(root);

		if (this.rows.length === 0) {
			root.createDiv({
				cls: "patina-empty",
				text: "Nothing is decaying. Every note is inside its half-life, snoozed, or evergreen.",
			});
			return;
		}

		const grouping = this.plugin.topics;
		if (grouping) {
			this.renderGrouped(root, grouping.groups, grouping.ungrouped);
			return;
		}

		const list = root.createDiv({ cls: "patina-list" });
		for (const row of this.rows) this.renderRow(list, row);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "patina-queue-header" });

		const sortLabel = header.createEl("label", { cls: "patina-sort" });
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

		// Already grouped: the button's job is now to get back to the flat worklist. No Pro gate
		// on ungrouping — a user whose licence lapsed mid-session must not be stranded in a view
		// they cannot leave.
		if (this.plugin.topics) {
			const ungroup = header.createEl("button", {
				cls: "patina-topic-btn",
				text: "Ungroup",
			});
			this.registerDomEvent(ungroup, "click", () => {
				this.plugin.clearTopicGroups();
			});
			return;
		}

		// The Pro surface. It is rendered for free users too — a locked row that says what it
		// would do is an honest paywall; a hidden feature is a feature nobody buys. The
		// COMMAND is hidden from the palette instead (see commands.ts), because a palette
		// entry that can only ever fail is noise.
		const topic = header.createEl("button", {
			cls: "patina-topic-btn",
			text: FEATURES.topicGroups.label,
		});
		topic.createSpan({ cls: "patina-pro-pill", text: "Pro" });
		if (!this.plugin.settings.isPro) topic.addClass("is-locked");
		this.registerDomEvent(topic, "click", () => {
			requirePro({ isPro: this.plugin.settings.isPro, app: this.app }, "topicGroups", () => {
				void this.plugin.groupQueueByTopic();
			});
		});
		topic.setAttr(
			"aria-label",
			"Clusters the queue by topic so one review session covers one subject. Needs the semantic engine (desktop)."
		);
	}

	/**
	 * The grouped queue.
	 *
	 * THREE sections, and the second and third are the reason this is not four lines:
	 *  - the topics themselves;
	 *  - `ungrouped` — notes the engine compared and found no topic for. Still rotting, still
	 *    listed. Dropping them would turn "group the queue" into "hide most of the queue";
	 *  - notes BELOW the session cap, which were never compared at all. They are labelled as
	 *    such rather than swept into "no shared topic", which would be a claim we did not make.
	 *
	 * Every row in the flat queue appears in exactly one of the three. Grouping never loses a note.
	 */
	private renderGrouped(root: HTMLElement, groups: TopicGroup[], ungrouped: QueueRow[]): void {
		if (groups.length === 0) {
			root.createDiv({ cls: "patina-empty", text: EMPTY_TOPIC_GROUPS });
		}

		const seen = new Set<string>();
		for (const group of groups) {
			const section = root.createDiv({ cls: "patina-group" });
			const head = section.createDiv({ cls: "patina-group-head" });
			head.createSpan({ cls: "patina-group-label", text: group.label });
			head.createSpan({
				cls: "patina-group-count",
				text: `${group.members.length} notes · ${Math.round(group.cohesion * 100)}% alike`,
			});

			const list = section.createDiv({ cls: "patina-list" });
			for (const row of group.members) {
				seen.add(row.path);
				this.renderRow(list, row);
			}
		}

		for (const row of ungrouped) seen.add(row.path);
		this.renderSection(root, "No shared topic", ungrouped);

		const uncompared = this.rows.filter((row) => !seen.has(row.path));
		this.renderSection(root, "Below the session cap — not compared", uncompared);
	}

	private renderSection(root: HTMLElement, label: string, rows: QueueRow[]): void {
		if (rows.length === 0) return;
		const section = root.createDiv({ cls: "patina-group" });
		section.createDiv({ cls: "patina-group-head" }).createSpan({
			cls: "patina-group-label",
			text: label,
		});
		const list = section.createDiv({ cls: "patina-list" });
		for (const row of rows) this.renderRow(list, row);
	}

	private renderRow(list: HTMLElement, row: QueueRow): void {
		const item = list.createDiv({ cls: "patina-row" });
		item.setAttr("data-decay", row.band);

		const main = item.createDiv({ cls: "patina-row-main" });
		const title = main.createEl("a", { cls: "patina-row-title", text: row.title });
		title.setAttr("href", "#");
		this.registerDomEvent(title, "click", (event: MouseEvent) => {
			event.preventDefault();
			void this.plugin.openNote(row.path, event);
		});

		const meta = main.createDiv({ cls: "patina-row-meta" });
		meta.createSpan({ cls: "patina-score", text: String(row.score) });
		meta.createSpan({ cls: "patina-band", text: row.band });
		if (row.editMs > 0) {
			meta.createSpan({ cls: "patina-effort", text: formatDuration(row.editMs) });
		}

		if (row.reasons.length > 0) {
			item.createDiv({ cls: "patina-reasons", text: row.reasons.join(" ") });
		}

		const actions = item.createDiv({ cls: "patina-row-actions" });
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
