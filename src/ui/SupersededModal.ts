import { Modal, type App } from "obsidian";
import { supersededReason } from "../core/topics.mjs";
import type { SupersededNote } from "../core/topics.d.mts";
import { EMPTY_SUPERSEDED } from "../core/engineCopy.mjs";
import { MAX_SESSION_NOTES } from "../semantic";

/**
 * PRO. The stale notes a newer note has already replaced (DESIGN 8.1).
 *
 * This modal is only ever opened when the engine ACTUALLY RAN. An empty list here therefore
 * means "nothing is superseded" — a real finding — and it says so in those words. Every way the
 * feature can fail to run instead opens SemanticGate's block modal, which says why. The two are
 * kept apart because they look identical to a user and mean opposite things.
 *
 * Nothing here is destructive. It reports; the user decides. A false "this is superseded" would
 * cost someone a note they wrote, so the copy hedges ("probably") and the only actions are
 * "open it" and "snooze it".
 */
export interface SupersededHost {
	readonly app: App;
	openNote(path: string, event?: MouseEvent): Promise<void>;
	snooze(path: string): Promise<void>;
}

export class SupersededModal extends Modal {
	constructor(
		private readonly host: SupersededHost,
		private readonly notes: readonly SupersededNote[],
		private readonly scanned: number
	) {
		super(host.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("note-decay-superseded");
		this.titleEl.setText("Superseded notes");

		if (this.notes.length === 0) {
			contentEl.createEl("p", { cls: "note-decay-empty", text: EMPTY_SUPERSEDED });
			return;
		}

		contentEl.createEl("p", {
			cls: "note-decay-superseded-lead",
			text:
				`${this.notes.length} of the top ${Math.min(this.scanned, MAX_SESSION_NOTES)} notes in the ` +
				"review queue look like they have been replaced by newer ones. This is a similarity " +
				"score, not a verdict — open one before you act on it.",
		});

		const list = contentEl.createDiv({ cls: "note-decay-superseded-list" });
		for (const note of this.notes) this.renderRow(list, note);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderRow(list: HTMLElement, note: SupersededNote): void {
		const row = list.createDiv({ cls: "note-decay-superseded-row" });

		const head = row.createDiv({ cls: "note-decay-row-main" });
		const title = head.createEl("a", { cls: "note-decay-row-title", text: note.title });
		title.setAttr("href", "#");
		title.addEventListener("click", (event: MouseEvent) => {
			event.preventDefault();
			this.close();
			void this.host.openNote(note.path, event);
		});
		head.createDiv({ cls: "note-decay-row-meta" }).createSpan({
			cls: "note-decay-score",
			text: String(note.score),
		});

		row.createDiv({ cls: "note-decay-reasons", text: supersededReason(note) });

		// The superseding notes, by name and clickable — the claim is only checkable if the user
		// can read the notes it is about.
		const by = row.createDiv({ cls: "note-decay-superseded-by" });
		for (const source of note.by) {
			const link = by.createEl("a", { cls: "note-decay-superseded-link", text: source.title });
			link.setAttr("href", "#");
			link.addEventListener("click", (event: MouseEvent) => {
				event.preventDefault();
				this.close();
				void this.host.openNote(source.path, event);
			});
		}

		const actions = row.createDiv({ cls: "note-decay-row-actions" });
		const open = actions.createEl("button", { text: "Open" });
		open.addEventListener("click", () => {
			this.close();
			void this.host.openNote(note.path);
		});
		const snooze = actions.createEl("button", { text: "Snooze" });
		snooze.addEventListener("click", () => {
			void this.host.snooze(note.path);
			snooze.setAttr("disabled", "true");
			snooze.setText("Snoozed");
		});
	}
}
