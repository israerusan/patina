// The review queue and the CSV export — the pure half of everything the sidebar renders.
import assert from "node:assert";
import { buildQueue, isExcluded, sortQueue, toCsv } from "../src/core/queue.mjs";

const T = Date.parse("2026-07-14T00:00:00.000Z");
const DAY = 86_400_000;

const row = (over) => ({
	path: "a.md",
	title: "A",
	score: 50,
	band: "aging",
	reasons: [],
	halfLifeDays: 90,
	mtime: T,
	lastOpen: T,
	newestInboundMtime: T,
	editMs: 0,
	revisions: 0,
	...over,
});

// --- exclusion is on a FOLDER, not a string prefix ---------------------------
// The bug this pins: startsWith("Archive") also matches "Archived Ideas/note.md", silently
// dropping a folder the user never excluded.
{
	assert.equal(isExcluded("Archive/old.md", ["Archive"]), true);
	assert.equal(isExcluded("Archived Ideas/new.md", ["Archive"]), false, "a prefix is not a folder");
	assert.equal(isExcluded("Archive/deep/old.md", ["Archive"]), true);
	assert.equal(isExcluded("archive/old.md", ["Archive"]), true, "folder matching is case-insensitive");
	assert.equal(isExcluded("a.md", []), false);
	assert.equal(isExcluded("a.md", ["", "  "]), false, "a blank line in the settings box excludes nothing");
	assert.equal(isExcluded("Archive/old.md", ["/Archive/"]), true, "stray slashes are tolerated");
}

// --- exempt notes are DROPPED, not sorted to the bottom ----------------------
// A queue you have to scroll past 400 evergreen notes to use is not a queue.
{
	const queue = buildQueue([
		row({ path: "evergreen.md", band: "exempt", score: 0 }),
		row({ path: "stale.md", band: "stale", score: 70 }),
	]);
	assert.deepEqual(
		queue.map((r) => r.path),
		["stale.md"]
	);
}

// --- minScore, and excluded folders ------------------------------------------
{
	const queue = buildQueue(
		[
			row({ path: "low.md", score: 10 }),
			row({ path: "Archive/high.md", score: 95, band: "decayed" }),
			row({ path: "high.md", score: 95, band: "decayed" }),
		],
		{ minScore: 30, excludeFolders: ["Archive"] }
	);
	assert.deepEqual(
		queue.map((r) => r.path),
		["high.md"]
	);
}

// --- sorting -----------------------------------------------------------------
{
	const rows = [
		row({ path: "b.md", score: 70, mtime: T - 10 * DAY, lastOpen: T - 2 * DAY, editMs: 60_000 }),
		row({ path: "a.md", score: 90, mtime: T - 1 * DAY, lastOpen: T - 50 * DAY, editMs: 10_000 }),
		row({ path: "c.md", score: 70, mtime: T - 30 * DAY, lastOpen: T - 9 * DAY, editMs: 999_000 }),
	];

	assert.deepEqual(
		sortQueue(rows, "score").map((r) => r.path),
		["a.md", "b.md", "c.md"],
		"score: highest first, ties broken by path so the order is stable across renders"
	);
	assert.deepEqual(
		sortQueue(rows, "mtime").map((r) => r.path),
		["c.md", "b.md", "a.md"],
		"mtime: the most neglected first"
	);
	assert.deepEqual(
		sortQueue(rows, "lastOpen").map((r) => r.path),
		["a.md", "c.md", "b.md"],
		"lastOpen: longest-unread first"
	);
	assert.deepEqual(
		sortQueue(rows, "effort").map((r) => r.path),
		["c.md", "b.md", "a.md"],
		"effort: the most editing time first (Effort Index's aggregate, via the shared log)"
	);

	// An unknown sort must not throw or return an empty list — it falls back to score.
	assert.deepEqual(
		sortQueue(rows, "nonsense").map((r) => r.path),
		["a.md", "b.md", "c.md"]
	);

	// Sorting does not mutate its input.
	assert.equal(rows[0].path, "b.md");
}

// --- effort sorts to 0 when Effort Index is not installed --------------------
// No dependency in either direction: the column is simply empty, and the sort degrades to
// the stable path tie-break rather than throwing on an undefined aggregate.
{
	const rows = [row({ path: "b.md", editMs: 0 }), row({ path: "a.md", editMs: 0 })];
	assert.deepEqual(
		sortQueue(rows, "effort").map((r) => r.path),
		["a.md", "b.md"]
	);
}

// --- CSV ----------------------------------------------------------------------
{
	const csv = toCsv([
		row({
			path: 'Notes/why, "really".md',
			score: 88,
			band: "decayed",
			reasons: ["Not edited in 300 days.", "Never opened."],
			editMs: 3_600_000,
			revisions: 4,
			lastOpen: 0,
		}),
	]);
	const lines = csv.trim().split("\n");
	assert.equal(lines[0], "path,score,band,halfLifeDays,lastEditedISO,lastOpenedISO,newestInboundISO,editMinutes,revisions,reasons");

	// A path with a comma AND a quote in it is the case that corrupts a naive exporter.
	assert.ok(lines[1].startsWith('"Notes/why, ""really"".md",88,decayed,90,'), lines[1]);
	assert.ok(lines[1].includes("2026-07-14T00:00:00.000Z"), "timestamps are ISO-8601, never a locale format");

	// A field is quoted only when it HAS to be — these reasons contain no comma or quote,
	// so quoting them would be noise a spreadsheet then shows literally.
	assert.ok(lines[1].endsWith("60,4,Not edited in 300 days. Never opened."), lines[1]);

	// lastOpen === 0 (never opened) renders as EMPTY, not as 1970-01-01.
	assert.ok(!lines[1].includes("1970"), "a never-opened note must not export as the epoch");
	assert.ok(lines[1].includes(",,"), "the never-opened column is empty");

	// ...and a reason that DOES contain a comma is quoted, so the row keeps its column count.
	const risky = toCsv([row({ reasons: ["Not edited in 300 days, and never opened."] })])
		.trim()
		.split("\n")[1];
	assert.ok(risky.endsWith('"Not edited in 300 days, and never opened."'), risky);
	assert.equal(
		splitCsvRow(risky).length,
		10,
		"a comma inside a field must not add a column — that is the whole point of the quoting"
	);

	assert.equal(toCsv([]).trim(), lines[0], "an empty queue still exports its header row");
}

/** A minimal RFC 4180 reader, so the column-count assertion is a real parse and not a split. */
function splitCsvRow(line) {
	const fields = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (quoted) {
			if (char === '"' && line[i + 1] === '"') {
				field += '"';
				i++;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ",") {
			fields.push(field);
			field = "";
		} else {
			field += char;
		}
	}
	fields.push(field);
	return fields;
}

console.log("ok  queue.test.mjs");
