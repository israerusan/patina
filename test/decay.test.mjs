// The score. Every assertion here is a claim DESIGN 8.1 makes in prose; if one of them
// goes red, the number the user sees no longer means what the README says it means.
import assert from "node:assert";
import {
	ageDays,
	decayScore,
	freshness,
	halfLifeFor,
	inboundRecency,
	profileFromFrontmatter,
} from "../src/core/decay.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-14T00:00:00.000Z");
const ago = (days) => NOW - days * DAY;

/** A note with all three signals at the same age. */
function evenlyAged(days, profile = "slow") {
	return {
		mtime: ago(days),
		lastOpen: ago(days),
		firstSeen: ago(days + 1),
		newestInboundMtime: ago(days),
		profile,
	};
}

// --- evergreen ==> exempt ----------------------------------------------------
// H === 0 does not mean "decays infinitely fast" and it does not mean "fresh". It means
// the user has declared the note does not rot, and the queue must never show it.
{
	const result = decayScore(evenlyAged(3650, "evergreen"), NOW);
	assert.equal(result.band, "exempt", "evergreen must be exempt at ANY age");
	assert.equal(result.score, 0);
	assert.equal(result.halfLifeDays, 0);
}

// --- a fresh note scores < 30 ------------------------------------------------
{
	const result = decayScore(evenlyAged(0), NOW);
	assert.ok(result.score < 30, `a note touched today must be fresh, got ${result.score}`);
	assert.equal(result.band, "fresh");
	assert.deepEqual(result.reasons, [], "a fresh note has nothing to explain");
}

// --- untouched for 2 x H scores >= 75 ---------------------------------------
// Two half-lives means every signal is at 0.25 freshness, so staleness is exactly 0.75.
// This is the load-bearing arithmetic of the whole model.
{
	const result = decayScore(evenlyAged(180, "slow"), NOW); // slow H = 90
	assert.ok(result.score >= 75, `2 x H must score >= 75, got ${result.score}`);
	assert.equal(result.band, "stale");

	const fast = decayScore(evenlyAged(28, "fast"), NOW); // fast H = 14
	assert.ok(fast.score >= 75, `2 x H on the fast profile must score >= 75, got ${fast.score}`);
}

// --- missing inbound links RENORMALIZE, they do not penalize -----------------
// The bug this pins: treating a missing signal as freshness 0. Every orphan note in the
// vault would read as decayed on day one, and the queue would be useless.
{
	const days = 90;
	const withInbound = decayScore(
		{
			mtime: ago(days),
			lastOpen: ago(days),
			firstSeen: ago(days + 1),
			newestInboundMtime: ago(days),
			profile: "slow",
		},
		NOW
	);
	const noInbound = decayScore(
		{
			mtime: ago(days),
			lastOpen: ago(days),
			firstSeen: ago(days + 1),
			newestInboundMtime: 0,
			profile: "slow",
		},
		NOW
	);

	// At one half-life every present signal is at 0.5, so renormalizing over {mtime, open}
	// gives exactly the same staleness as over {mtime, open, inbound}. That equality is the
	// definition of "absence neither penalizes nor rewards".
	assert.equal(
		noInbound.score,
		withInbound.score,
		"a note with no inbound links must score the same as one whose inbound link is equally old"
	);

	// And it must be strictly BETTER than the penalizing model would have given it.
	const penalized = Math.round((1 - (0.5 * 0.5 + 0.3 * 0.5 + 0.2 * 0)) * 100);
	assert.ok(
		noInbound.score < penalized,
		`renormalized (${noInbound.score}) must beat the penalizing model (${penalized})`
	);

	assert.ok(
		noInbound.reasons.includes("No inbound links."),
		"the absence is still REPORTED — it just is not scored"
	);
}

// --- a future mtime is age 0, never a negative age --------------------------
// Clock skew, a synced file from a machine an hour ahead, a template that stamps tomorrow.
// A negative age makes freshness > 1 and drives the score below zero.
{
	const skewed = decayScore(
		{
			mtime: NOW + 30 * DAY,
			lastOpen: NOW + 30 * DAY,
			firstSeen: NOW,
			newestInboundMtime: NOW + 30 * DAY,
			profile: "slow",
		},
		NOW
	);
	assert.equal(skewed.score, 0, "a future timestamp must clamp to age 0, not go negative");
	assert.equal(skewed.band, "fresh");
	assert.equal(ageDays(NOW + DAY, NOW), 0);
}

// --- never opened dates from firstSeen, not from the epoch -------------------
// The install-day bug: `now - 0` is 56 years, so EVERY note would be maximally decayed the
// moment the plugin is installed and the queue would be the entire vault.
{
	const neverOpened = decayScore(
		{ mtime: ago(1), lastOpen: 0, firstSeen: ago(2), newestInboundMtime: ago(1), profile: "slow" },
		NOW
	);
	assert.ok(
		neverOpened.score < 30,
		`a note we have only known about for 2 days must not be decayed, got ${neverOpened.score}`
	);
	assert.ok(neverOpened.reasons.some((r) => r.includes("Never opened")));
}

// --- bands -------------------------------------------------------------------
// staleness = 1 - 0.5^(d/90) when all three signals are the same age, so these ages land
// in each band by construction. `< 30 fresh`, `30-59 aging`, `60-84 stale`, `>= 85 decayed`.
{
	assert.equal(decayScore(evenlyAged(0), NOW).band, "fresh");
	assert.equal(decayScore(evenlyAged(50), NOW).band, "aging"); // ~32
	assert.equal(decayScore(evenlyAged(120), NOW).band, "stale"); // ~60
	assert.equal(decayScore(evenlyAged(260), NOW).band, "decayed"); // ~87

	// A note with no history at all is unscorable, not NaN.
	const nothing = decayScore({ mtime: 0, lastOpen: 0, firstSeen: 0, newestInboundMtime: 0 }, NOW);
	assert.equal(nothing.score, 0);
	assert.equal(nothing.band, "fresh");
	assert.ok(Number.isFinite(nothing.score), "an unscorable note must not produce NaN");
}

// --- a snoozed note is exempt, not fresh ------------------------------------
{
	const snoozed = decayScore({ ...evenlyAged(365), snoozedUntil: NOW + 5 * DAY }, NOW);
	assert.equal(snoozed.band, "exempt");
	// ...and the moment the snooze lapses it is decayed again. It was never actually fresh.
	const lapsed = decayScore({ ...evenlyAged(365), snoozedUntil: NOW - DAY }, NOW);
	assert.equal(lapsed.band, "decayed");
}

// --- an unknown profile falls back to the default, NOT to evergreen ----------
// A typo in frontmatter (`decay: evergreeen`) must not silently exempt the note forever.
{
	assert.equal(halfLifeFor("evergreeen"), 90, "a typo falls back to the default profile");
	assert.equal(halfLifeFor(undefined), 90);
	assert.equal(halfLifeFor("fast"), 14);
	assert.equal(halfLifeFor("EVERGREEN"), 0, "the profile is case-insensitive");
	assert.equal(halfLifeFor("fast", { halfLives: { fast: 7 } }), 7, "settings override the table");

	const typo = decayScore({ ...evenlyAged(365), profile: "evergreeen" }, NOW);
	assert.notEqual(typo.band, "exempt", "a typo must NOT exempt the note");
}

// --- freshness is a real half-life ------------------------------------------
{
	assert.equal(freshness(0, 90), 1);
	assert.equal(freshness(90, 90), 0.5);
	assert.equal(freshness(180, 90), 0.25);
}

// --- inbound recency ---------------------------------------------------------
{
	const mtimes = { "a.md": ago(10), "b.md": ago(3), "c.md": ago(100) };
	const links = {
		"a.md": { "c.md": 1 },
		"b.md": { "c.md": 2 },
		"c.md": { "c.md": 1 }, // a self-link is not evidence anyone else cares
	};
	const newest = inboundRecency(links, mtimes);
	assert.equal(newest["c.md"], ago(3), "inbound recency is the NEWEST linking note's mtime");
	assert.equal(newest["a.md"], undefined, "nothing links to a.md");
	assert.equal(inboundRecency(null, mtimes)["c.md"], undefined, "a missing link graph is not a crash");
}

// --- frontmatter ------------------------------------------------------------
{
	assert.equal(profileFromFrontmatter({ decay: "Fast" }), "fast");
	assert.equal(profileFromFrontmatter({ decay: "  " }), undefined);
	assert.equal(profileFromFrontmatter({ decay: 14 }), undefined, "a number is not a profile name");
	assert.equal(profileFromFrontmatter(null), undefined);
	assert.equal(profileFromFrontmatter({ rot: "fast" }, "rot"), "fast", "the key is configurable");
}

console.log("ok  decay.test.mjs");
