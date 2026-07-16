import { SuggestModal, type App } from "obsidian";
import { PROFILE_LABELS, type ProfileLabel } from "../settings";

/**
 * "Set decay profile for this note" — the picker.
 *
 * The list comes from PROFILE_LABELS, the same data the settings tab renders, so the two
 * can never disagree about what "evergreen" means or which profiles exist.
 */
export class ProfileSuggestModal extends SuggestModal<ProfileLabel> {
	constructor(
		app: App,
		private onChoose: (profile: ProfileLabel) => void
	) {
		super(app);
		this.setPlaceholder("Pick a decay profile for this note");
	}

	getSuggestions(query: string): ProfileLabel[] {
		const needle = query.trim().toLowerCase();
		if (needle === "") return [...PROFILE_LABELS];
		return PROFILE_LABELS.filter(
			(profile) =>
				profile.id.includes(needle) ||
				profile.name.toLowerCase().includes(needle) ||
				profile.desc.toLowerCase().includes(needle)
		);
	}

	renderSuggestion(profile: ProfileLabel, el: HTMLElement): void {
		el.createDiv({ cls: "patina-suggest-name", text: profile.name });
		el.createDiv({ cls: "patina-suggest-desc", text: profile.desc });
	}

	onChooseSuggestion(profile: ProfileLabel): void {
		this.onChoose(profile);
	}
}
