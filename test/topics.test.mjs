// The two Pro features, as arithmetic. No vault, no engine, no binary — the ranking rules are
// what a buyer is paying for, so they are the part that is pinned.
//
// THE BUG THIS FILE EXISTS AGAINST: the add-on shipped a "$29 — Unlock Pro" button for
// `topicGroups` and `superseded`, and neither existed. `isPro` gated nothing. These are the
// rules the features now actually implement.
import assert from "node:assert";
import {
	SUPERSEDED_MIN_NOTES,
	SUPERSEDED_MIN_SCORE,
	TOPIC_MIN_SCORE,
	groupByTopic,
	rankSuperseded,
	supersededReason,
} from "../src/core/topics.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-14T00:00:00.000Z");
const ago = (days) => NOW - days * DAY;

/** A queue row, with only the fields the grouping and the ranking read. */
function row(path, score, mtimeDays = 100) {
	return {
		path,
		title: path.replace(/\.md$/, ""),
		score,
		band: score >= 85 ? "decayed" : "stale",
		reasons: [],
		halfLifeDays: 90,
		mtime: ago(mtimeDays),
		lastOpen: 0,
		newestInboundMtime: 0,
		editMs: 0,
		revisions: 0,
	};
}

/* ------------------------------------------------------- topic grouping ----- */

{
	// Two clusters and a loner. crdt/storage/merge talk about one thing; taxes/receipts about
	// another; "Groceries" about nothing anyone else is writing about.
	const rows = [
		row("crdt.md", 90),
		row("storage.md", 70),
		row("merge.md", 60),
		row("taxes.md", 88),
		row("receipts.md", 55),
		row("groceries.md", 95),
	];
	const neighbours = {
		"crdt.md": [
			{ note: "storage.md", score: 0.81 },
			{ note: "taxes.md", score: 0.12 },
		],
		"storage.md": [{ note: "merge.md", score: 0.72 }],
		// merge.md's own top-k does not mention crdt.md — a k-NN list is truncated, and the edge
		// still exists. The grouping must be undirected or a real topic splits on the value of k.
		"merge.md": [],
		"taxes.md": [{ note: "receipts.md", score: 0.9 }],
		"receipts.md": [{ note: "taxes.md", score: 0.9 }],
		"groceries.md": [{ note: "receipts.md", score: 0.31 }],
	};

	const { groups, ungrouped } = groupByTopic(rows, neighbours);

	assert.equal(groups.length, 2, "two topics");
	assert.deepEqual(
		groups.map((g) => g.members.map((m) => m.path)),
		[
			// Most decayed topic first (crdt is 90, taxes is 88), most decayed note first inside it.
			["crdt.md", "storage.md", "merge.md"],
			["taxes.md", "receipts.md"],
		],
		"a chain (crdt~storage~merge) is ONE topic, even though crdt and merge never matched directly"
	);

	// The 95-score loner is not in a group; it is not lost either.
	assert.deepEqual(
		ungrouped.map((r) => r.path),
		["groceries.md"],
		"a note with no neighbour above the threshold comes back in `ungrouped` — never dropped"
	);

	// Every input row appears exactly once across groups + ungrouped. Grouping the queue must
	// not be able to LOSE a note; a review queue that silently shrinks is worse than an ungrouped one.
	const seen = [...groups.flatMap((g) => g.members.map((m) => m.path)), ...ungrouped.map((r) => r.path)];
	assert.equal(seen.length, rows.length);
	assert.equal(new Set(seen).size, rows.length);

	// The group is named after its most CENTRAL note (greatest total similarity to the rest),
	// not the first one alphabetically and not the most decayed one.
	const chain = groups.find((g) => g.members.some((m) => m.path === "crdt.md"));
	assert.equal(chain.centroid, "storage.md", "storage.md is the note the other two both match");
	assert.equal(chain.label, "storage");
	assert.equal(chain.cohesion, 0.765, "cohesion is the mean weight of the edges that formed the group");

	// The topic list is a worklist: the group holding the most decayed note comes first.
	assert.equal(groups[0].score, 90);
	assert.equal(groups[1].score, 88);
}

{
	// A hit BELOW the threshold is not a topic. 0.59 against a 0.60 floor is "related-ish", and
	// grouping on it would put every note in one blob.
	const rows = [row("a.md", 90), row("b.md", 80)];
	const { groups, ungrouped } = groupByTopic(rows, {
		"a.md": [{ note: "b.md", score: TOPIC_MIN_SCORE - 0.01 }],
	});
	assert.equal(groups.length, 0);
	assert.equal(ungrouped.length, 2, "both notes survive, ungrouped");

	// ...and exactly at the threshold, it is.
	const at = groupByTopic(rows, { "a.md": [{ note: "b.md", score: TOPIC_MIN_SCORE }] });
	assert.equal(at.groups.length, 1);
	assert.equal(at.ungrouped.length, 0);
}

{
	// A hit on a note that is NOT in this session (it is fresh, or excluded, or below the
	// minimum score) is not an edge. The session is what the user is reviewing.
	const rows = [row("a.md", 90), row("b.md", 80)];
	const { groups, ungrouped } = groupByTopic(rows, {
		"a.md": [{ note: "fresh.md", score: 0.99 }],
		"b.md": [{ note: "fresh.md", score: 0.98 }],
	});
	assert.equal(groups.length, 0, "two notes that both match a THIRD note are not thereby a topic");
	assert.equal(ungrouped.length, 2);
}

{
	// Empty in, empty out — and no crash on a missing neighbour list.
	const { groups, ungrouped } = groupByTopic([], {});
	assert.deepEqual(groups, []);
	assert.deepEqual(ungrouped, []);
	const solo = groupByTopic([row("a.md", 50)], {});
	assert.equal(solo.groups.length, 0);
	assert.equal(solo.ungrouped.length, 1);
}

/* --------------------------------------------------------- superseded ------- */

{
	// DESIGN 6.5: max-sim >= 0.78 from >= 2 NEWER notes.
	const stale = { path: "old.md", title: "Old", score: 91, mtime: ago(400) };

	// TWO newer notes cover it. This is the pattern that means "you rewrote this".
	const superseded = rankSuperseded([
		{
			...stale,
			hits: [
				{ note: "new-a.md", title: "New A", mtime: ago(10), score: 0.84 },
				{ note: "new-a.md", title: "New A", mtime: ago(10), score: 0.79 }, // same note, 2nd chunk
				{ note: "new-b.md", title: "New B", mtime: ago(5), score: 0.81 },
			],
		},
	]);
	assert.equal(superseded.length, 1);
	assert.equal(superseded[0].byCount, 2, "two chunks of ONE note are one superseding note, not two");
	assert.deepEqual(
		superseded[0].by.map((n) => n.path),
		["new-a.md", "new-b.md"]
	);
	assert.equal(superseded[0].by[0].score, 0.84, "a note's contribution is its BEST chunk, not its last");
	assert.ok(
		Math.abs(superseded[0].confidence - 0.825) < 1e-6,
		`confidence is the mean over superseding notes, got ${superseded[0].confidence}`
	);
	assert.match(supersededReason(superseded[0]), /Probably superseded by New A and New B — 83% match/);
}

{
	// ONE close newer note is NOT enough. A single 0.95 match is a follow-up, a reply, or a
	// note with the same title — and calling that "superseded" is how a tool talks a user into
	// deleting something they still needed.
	const one = rankSuperseded([
		{
			path: "old.md",
			title: "Old",
			score: 91,
			mtime: ago(400),
			hits: [{ note: "new-a.md", mtime: ago(10), score: 0.95 }],
		},
	]);
	assert.equal(one.length, 0, `one newer note is not ${SUPERSEDED_MIN_NOTES}`);
}

{
	// Two newer notes, both BELOW the similarity floor. "On the same subject" is not "replaces".
	const weak = rankSuperseded([
		{
			path: "old.md",
			title: "Old",
			score: 91,
			mtime: ago(400),
			hits: [
				{ note: "a.md", mtime: ago(10), score: SUPERSEDED_MIN_SCORE - 0.01 },
				{ note: "b.md", mtime: ago(10), score: 0.6 },
			],
		},
	]);
	assert.equal(weak.length, 0);
}

{
	// THE CLAIM IS "NEWER". An OLDER note cannot supersede anything, however similar it is —
	// and the engine's `newerThan` is not trusted on its own: it is re-checked here, from the
	// vault's own mtimes, because an off-by-one there tells the user their note was replaced by
	// something they wrote before it.
	const backwards = rankSuperseded([
		{
			path: "new.md",
			title: "New",
			score: 91,
			mtime: ago(10),
			hits: [
				{ note: "ancient-a.md", mtime: ago(400), score: 0.95 },
				{ note: "ancient-b.md", mtime: ago(300), score: 0.93 },
				{ note: "same-second.md", mtime: ago(10), score: 0.99 }, // identical mtime is not newer
			],
		},
	]);
	assert.equal(backwards.length, 0, "nothing older, and nothing simultaneous, can supersede a note");
}

{
	// A note cannot supersede itself. The engine is told to `exclude` the candidate; if it ever
	// forgets, the self-hit is a 1.0 and would supersede every note in the vault.
	const selfish = rankSuperseded([
		{
			path: "old.md",
			title: "Old",
			score: 91,
			mtime: ago(400),
			hits: [
				{ note: "old.md", mtime: ago(1), score: 1.0 },
				{ note: "a.md", mtime: ago(10), score: 0.9 },
			],
		},
	]);
	assert.equal(selfish.length, 0, "a self-hit is discarded, so only ONE real superseding note remains");
}

{
	// Ranking: most confident first. And the citation list is capped while the COUNT is not —
	// "and 2 more" is information; a truncated list that pretends to be complete is not.
	const many = (path, scores) => ({
		path,
		title: path.replace(/\.md$/, ""),
		score: 80,
		mtime: ago(400),
		hits: scores.map((score, i) => ({
			note: `n${i}-${path}`,
			title: `N${i}`,
			mtime: ago(10),
			score,
		})),
	});
	const ranked = rankSuperseded([
		many("weak.md", [0.79, 0.79]),
		many("strong.md", [0.95, 0.93, 0.91, 0.9, 0.88]),
	]);
	assert.deepEqual(
		ranked.map((r) => r.path),
		["strong.md", "weak.md"]
	);
	assert.equal(ranked[0].by.length, 3, "at most three are named");
	assert.equal(ranked[0].byCount, 5, "…and the count reports all five");
	assert.match(supersededReason(ranked[0]), /and 2 more/);
}

assert.equal(SUPERSEDED_MIN_SCORE, 0.78, "DESIGN 6.5 pins this");
assert.equal(SUPERSEDED_MIN_NOTES, 2, "DESIGN 8.1 pins this");

console.log("ok  topics.test.mjs");
