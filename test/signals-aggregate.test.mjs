// The shared activity log, folded (DESIGN 5.4 / 8.1). This is VENDORED code — it is
// authored and unit-tested in obsidian-plugin-core — but Note Decay's whole `lastOpen`
// signal is this fold, and a drift in the vendored copy would silently change every score
// in the vault. So it is exercised here too, against the copy that actually ships.
import assert from "node:assert";
import { foldSignals, mergeSignals } from "../src/shared/signals/signalsAggregate.mjs";

const T = Date.parse("2026-07-14T00:00:00.000Z");
const min = (n) => n * 60_000;

// --- edit ms sums ACROSS shards ---------------------------------------------
// Two Second Read add-ons, two shards, one vault. The reader merges both — that is the
// entire reason the log is shared rather than private to each plugin.
{
	const shardA = foldSignals([
		{ t: T, k: "edit", p: "a.md", ms: min(10), keys: 300 },
		{ t: T + min(1), k: "open", p: "a.md" },
	]);
	const shardB = foldSignals([{ t: T + min(120), k: "edit", p: "a.md", ms: min(5), keys: 120 }]);

	const merged = mergeSignals([shardA, shardB]);
	assert.equal(merged["a.md"].editMs, min(15), "edit ms is additive across shards");
	assert.equal(merged["a.md"].editSessions, 2);
}

// --- lastOpen takes the MAX, not the last one merged ------------------------
{
	const older = foldSignals([{ t: T, k: "open", p: "a.md" }]);
	const newer = foldSignals([{ t: T + min(600), k: "open", p: "a.md" }]);

	// Merge order must not matter: shards arrive in whatever order the adapter lists them.
	const forward = mergeSignals([older, newer]);
	const backward = mergeSignals([newer, older]);
	assert.equal(forward["a.md"].lastOpen, T + min(600));
	assert.equal(backward["a.md"].lastOpen, T + min(600), "lastOpen is a max, not a last-write-wins");
	assert.equal(forward["a.md"].opens, 2, "opens still sum");
}

// --- a rename carries the aggregate with the note ---------------------------
// Without this, renaming a note resets its decay score to "brand new" — the single most
// annoying possible bug in a staleness tracker.
{
	const index = foldSignals([
		{ t: T, k: "open", p: "old.md" },
		{ t: T + min(10), k: "edit", p: "old.md", ms: min(8), keys: 200 },
		{ t: T + min(11), k: "rename", p: "new.md", from: "old.md" },
	]);
	assert.equal(index["old.md"], undefined, "the old path is gone");
	assert.ok(index["new.md"], "the aggregate followed the rename");
	assert.equal(index["new.md"].opens, 1);
	assert.equal(index["new.md"].editMs, min(8));
	assert.equal(index["new.md"].lastOpen, T, "lastOpen survives the rename — the decay score depends on it");
}

// --- a reported duration is clamped to the wall clock ------------------------
// You cannot have spent 8 minutes editing a note we have only known about for 1. The fold
// clamps `ms` to the window since firstSeen, so a corrupt, replayed, or clock-skewed log
// line cannot inflate editMs — which is the number the queue's "effort" sort ranks on.
{
	const index = foldSignals([
		{ t: T, k: "open", p: "a.md" },
		{ t: T + min(1), k: "edit", p: "a.md", ms: min(8), keys: 200 },
	]);
	assert.equal(index["a.md"].editMs, min(1), "editMs is clamped to the elapsed wall clock");
}

// --- a delete drops the aggregate at fold time ------------------------------
{
	const index = foldSignals([
		{ t: T, k: "open", p: "gone.md" },
		{ t: T + min(1), k: "delete", p: "gone.md" },
		{ t: T + min(2), k: "open", p: "kept.md" },
	]);
	assert.equal(index["gone.md"], undefined, "a deleted note's aggregate is dropped");
	assert.ok(index["kept.md"], "and only that note's");
}

// --- the fold is order-independent ------------------------------------------
// Shards are merged as a union of lines from an append-only log that may have been synced
// between devices. There is no global ordering to rely on.
{
	const events = [
		{ t: T + min(3), k: "edit", p: "a.md", ms: min(4), keys: 90 },
		{ t: T, k: "open", p: "a.md" },
		{ t: T + min(9), k: "open", p: "a.md" },
	];
	const forward = foldSignals(events);
	const shuffled = foldSignals([...events].reverse());
	assert.deepEqual(shuffled, forward, "folding is independent of the order events arrive in");
}

console.log("ok  signals-aggregate.test.mjs");
