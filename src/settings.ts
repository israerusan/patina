import {
	DEFAULT_BANDS,
	DEFAULT_FRONTMATTER_KEY,
	DEFAULT_HALF_LIVES,
	DEFAULT_PROFILE,
	DEFAULT_WEIGHTS,
} from "./core/decay.mjs";
import type { BandThresholds, DecayWeights, HalfLives } from "./core/decay.d.mts";
import type { QueueSort } from "./core/queue.d.mts";

/**
 * The settings SHAPE and its defaults. Rendering lives in ui/SettingsTab.ts — importing
 * "the settings type" must not drag the whole settings tab, and every `obsidian` symbol it
 * touches, into the pure code that only wants to read a threshold.
 */
export interface NoteDecaySettings {
	licenseKey: string;
	/** Cached entitlement. Derived from licenseKey, persisted so startup is instant. */
	isPro: boolean;
	licenseEmail: string;
	/** "free" | "valid-pro" | "invalid" — what the License section renders. */
	licenseStatus: string;

	/** Half-life used when a note declares no profile (or an unknown one). */
	defaultProfile: string;
	halfLives: HalfLives;
	weights: DecayWeights;
	bandThresholds: BandThresholds;
	/** The frontmatter key a note declares its half-life under. */
	frontmatterKey: string;

	dimInExplorer: boolean;
	showStatusBar: boolean;
	excludeFolders: string[];

	queueSort: QueueSort;
	/** Notes below this score never enter the review queue. */
	queueMinScore: number;

	/** ms since the epoch, keyed by note path. Set by "Snooze this note". Never in the note. */
	snoozedUntil: Record<string, number>;
	/** Days a snooze lasts. */
	snoozeDays: number;

	/** This plugin's shard id in the shared signals log. Generated once, then stable. */
	signalsWriterId: string;

	/** Pro + engine. A BYO path to an engine binary the user already has (DESIGN 7.2). */
	enginePath: string;

	schemaVersion: number;
}

export const DEFAULT_SETTINGS: NoteDecaySettings = {
	licenseKey: "",
	isPro: false,
	licenseEmail: "",
	licenseStatus: "free",

	defaultProfile: DEFAULT_PROFILE,
	halfLives: { ...DEFAULT_HALF_LIVES },
	weights: { ...DEFAULT_WEIGHTS },
	bandThresholds: { ...DEFAULT_BANDS },
	frontmatterKey: DEFAULT_FRONTMATTER_KEY,

	dimInExplorer: true,
	showStatusBar: true,
	excludeFolders: [],

	queueSort: "score",
	queueMinScore: 30,

	snoozedUntil: {},
	snoozeDays: 30,

	signalsWriterId: "",

	enginePath: "",

	schemaVersion: 1,
};

export interface ProfileLabel {
	id: string;
	name: string;
	desc: string;
}

/**
 * One row per decay profile, as data rather than markup, so the settings tab and the
 * "Set decay profile for this note" suggester render the SAME list and cannot drift.
 */
export const PROFILE_LABELS: readonly ProfileLabel[] = [
	{
		id: "fast",
		name: "Fast",
		desc: "Two-week half-life. For meeting notes, inbox captures, and anything that is stale the moment it is cold.",
	},
	{
		id: "slow",
		name: "Slow",
		desc: "Three-month half-life. The default: reference notes that age, but not quickly.",
	},
	{
		id: "evergreen",
		name: "Evergreen",
		desc: "Never decays. The note is exempt from the queue at any age.",
	},
];
