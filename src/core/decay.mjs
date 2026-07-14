/**
 * The staleness score (DESIGN 8.1). Pure, synchronous, no `obsidian` import, no clock —
 * `now` is always passed in, so every band boundary is testable without waiting for time
 * to pass.
 *
 * THE MODEL. Each of the three signals — when the note was last edited, when it was last
 * opened, when anything last linked to it — decays on the SAME half-life `H`, taken from
 * the note's `decay:` frontmatter profile. Freshness is `0.5 ** (age / H)`: one half-life
 * of neglect halves a signal's freshness, which is the whole point of a half-life and is
 * why "how stale is this?" has an answer a user can predict.
 *
 *   staleness = 1 − Σ(wᵢ · fᵢ) / Σwᵢ      over the signals that EXIST
 *
 * RENORMALIZATION IS THE LOAD-BEARING PART. A note nobody links to has no inbound signal.
 * If a missing signal contributed 0 freshness, that note would be punished for a link its
 * author never asked for — every orphan would read as decayed on day one. So the weights
 * are renormalized over the signals actually present: absence neither penalizes nor
 * rewards. Same for a note we have never observed being opened, which is EVERY note in
 * the vault on the day this add-on is installed.
 */

/** Half-life in days per profile. `0` means "never decays". */
export const DEFAULT_HALF_LIVES = Object.freeze({ fast: 14, slow: 90, evergreen: 0 });

/** Relative weight of each signal, before renormalization. */
export const DEFAULT_WEIGHTS = Object.freeze({ mtime: 0.5, open: 0.3, inbound: 0.2 });

/** Score at or above which a note enters the band. `< aging` is "fresh". */
export const DEFAULT_BANDS = Object.freeze({ aging: 30, stale: 60, decayed: 85 });

export const DEFAULT_PROFILE = "slow";

/** The frontmatter key a note declares its half-life under. */
export const DEFAULT_FRONTMATTER_KEY = "decay";

const DAY_MS = 86_400_000;

/** Ordered so `reasons` and any UI legend always list signals the same way. */
const SIGNALS = ["mtime", "open", "inbound"];

function resolveOptions(opts) {
	const o = opts ?? {};
	return {
		halfLives: { ...DEFAULT_HALF_LIVES, ...(o.halfLives ?? {}) },
		weights: { ...DEFAULT_WEIGHTS, ...(o.weights ?? {}) },
		bands: { ...DEFAULT_BANDS, ...(o.bands ?? {}) },
		defaultProfile: o.defaultProfile ?? DEFAULT_PROFILE,
	};
}

/**
 * The half-life, in days, this note decays on.
 *
 * An unknown or missing profile falls back to `defaultProfile` rather than to a hardcoded
 * number — the user can rename their profiles in settings, and a typo in frontmatter must
 * not silently mean "evergreen" (which would make the note invisible to the queue forever).
 */
export function halfLifeFor(profile, opts) {
	const { halfLives, defaultProfile } = resolveOptions(opts);
	const named = typeof profile === "string" ? profile.trim().toLowerCase() : "";
	const value = halfLives[named];
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	const fallback = halfLives[defaultProfile];
	return typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0 ? fallback : 90;
}

/** Whole days between two instants, floored at 0 — a future timestamp is age 0, never negative. */
export function ageDays(then, now) {
	if (!Number.isFinite(then) || then <= 0) return 0;
	const ms = now - then;
	// Clock skew, a synced mtime from a machine an hour ahead, a note "created tomorrow" by
	// a template — all of them produce a NEGATIVE age, which would make freshness > 1 and
	// pull the score below zero. Clamp rather than trust the filesystem.
	return ms <= 0 ? 0 : ms / DAY_MS;
}

/** Freshness of one signal: 1 at age 0, 0.5 at one half-life, 0.25 at two. */
export function freshness(days, halfLifeDays) {
	if (!(halfLifeDays > 0)) return 1;
	return Math.pow(0.5, days / halfLifeDays);
}

/**
 * The ages of the signals this note actually has.
 *
 * `open` uses `firstSeen` when the note has never been opened *while we were watching*:
 * measuring from 0 (the epoch) would date every never-opened note to 1970 and score the
 * entire vault as decayed the moment the add-on is installed. "We have known about this
 * note for 3 days and you have not opened it" is the honest statement.
 */
function presentSignals(input, now) {
	const present = {};
	if (Number.isFinite(input.mtime) && input.mtime > 0) {
		present.mtime = ageDays(input.mtime, now);
	}
	const lastOpen = Number(input.lastOpen) || 0;
	const firstSeen = Number(input.firstSeen) || 0;
	if (lastOpen > 0) present.open = ageDays(lastOpen, now);
	else if (firstSeen > 0) present.open = ageDays(firstSeen, now);
	const inbound = Number(input.newestInboundMtime) || 0;
	if (inbound > 0) present.inbound = ageDays(inbound, now);
	return present;
}

function plural(days) {
	const n = Math.floor(days);
	return n === 1 ? "1 day" : `${n} days`;
}

function bandFor(score, bands) {
	if (score >= bands.decayed) return "decayed";
	if (score >= bands.stale) return "stale";
	if (score >= bands.aging) return "aging";
	return "fresh";
}

/**
 * Score one note, 0..100, higher = more decayed.
 *
 * `snoozedUntil` (optional; kept in the plugin's own data.json, never in the note) short-
 * circuits to `exempt` — a snoozed note is not "fresh", it is "not my problem yet", and
 * conflating the two would let the queue re-suggest it the moment it crosses a band.
 */
export function decayScore(input, now, opts) {
	const options = resolveOptions(opts);
	const at = Number.isFinite(now) ? now : Date.now();

	const snoozedUntil = Number(input?.snoozedUntil) || 0;
	if (snoozedUntil > at) {
		return { score: 0, band: "exempt", reasons: ["Snoozed."], halfLifeDays: 0 };
	}

	const halfLifeDays = halfLifeFor(input?.profile, options);
	// H === 0 is "evergreen": the user has declared this note does not rot. It is exempt,
	// not merely fresh — it never enters the queue, at any age.
	if (halfLifeDays === 0) {
		return { score: 0, band: "exempt", reasons: ["Evergreen — never decays."], halfLifeDays: 0 };
	}

	const ages = presentSignals(input ?? {}, at);
	const reasons = [];

	let weighted = 0;
	let total = 0;
	for (const key of SIGNALS) {
		const days = ages[key];
		if (days === undefined) continue;
		const weight = Number(options.weights[key]);
		if (!Number.isFinite(weight) || weight <= 0) continue;
		weighted += weight * freshness(days, halfLifeDays);
		total += weight;
	}

	// No signal at all (a note with no mtime and no history) is unscorable. Report it as
	// fresh with a reason rather than dividing by zero and shipping a NaN into the UI.
	if (total === 0) {
		return { score: 0, band: "fresh", reasons: ["Not enough history to score yet."], halfLifeDays };
	}

	const staleness = 1 - weighted / total;
	const score = Math.min(100, Math.max(0, Math.round(staleness * 100)));

	// Reasons explain the SCORE, so only signals past a half-life get one — a note edited
	// yesterday does not need to be told it was edited yesterday.
	if (ages.mtime !== undefined && ages.mtime >= halfLifeDays) {
		reasons.push(`Not edited in ${plural(ages.mtime)}.`);
	}
	if ((Number(input?.lastOpen) || 0) === 0) {
		reasons.push("Never opened since this add-on started watching.");
	} else if (ages.open !== undefined && ages.open >= halfLifeDays) {
		reasons.push(`Not opened in ${plural(ages.open)}.`);
	}
	if (ages.inbound === undefined) {
		// Stated, but NOT scored — see the renormalization note at the top of the file.
		reasons.push("No inbound links.");
	} else if (ages.inbound >= halfLifeDays) {
		reasons.push(`No note has linked here in ${plural(ages.inbound)}.`);
	}

	return { score, band: bandFor(score, options.bands), reasons, halfLifeDays };
}

/**
 * Newest mtime among the notes that link TO each note.
 *
 * `resolvedLinks` is Obsidian's shape: `{ [source]: { [target]: count } }`. Self-links are
 * ignored — a note linking to itself is not evidence that anyone else still cares about it,
 * and counting it would make every note with a self-reference permanently "fresh" on the
 * inbound signal.
 */
export function inboundRecency(resolvedLinks, mtimeByPath) {
	const newest = Object.create(null);
	if (!resolvedLinks) return newest;
	for (const source of Object.keys(resolvedLinks)) {
		const targets = resolvedLinks[source];
		if (!targets) continue;
		const sourceMtime = Number(mtimeByPath?.[source]) || 0;
		if (sourceMtime <= 0) continue;
		for (const target of Object.keys(targets)) {
			if (target === source) continue;
			if (!(newest[target] > sourceMtime)) newest[target] = sourceMtime;
		}
	}
	return newest;
}

/** Read a note's decay profile out of its frontmatter. Missing/non-string => undefined. */
export function profileFromFrontmatter(frontmatter, key = DEFAULT_FRONTMATTER_KEY) {
	const raw = frontmatter?.[key];
	if (typeof raw !== "string") return undefined;
	const value = raw.trim().toLowerCase();
	return value === "" ? undefined : value;
}
