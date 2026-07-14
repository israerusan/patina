/**
 * The review queue, as pure data (DESIGN 8.1). Everything the sidebar view renders is
 * computed here from plain objects — no `obsidian` import, no DOM — so the ranking and the
 * exclusion rules are testable without a vault.
 *
 * The `effort` sort reads `editMs` out of the SHARED signals store, which Effort Index
 * writes. When Effort Index is not installed it is simply 0 and the sort degrades to a
 * stable tie-break. That is the point of the shared log: a free cross-plugin bonus with no
 * dependency in either direction.
 */

/** Sort keys the view offers. */
export const QUEUE_SORTS = Object.freeze(["score", "mtime", "lastOpen", "effort"]);

/**
 * True when `path` sits inside one of `folders`.
 *
 * Prefix matching on the folder name plus a slash — NOT `startsWith(folder)`, which would
 * make "Archive" swallow "Archived Ideas/" and silently drop a folder the user never
 * excluded.
 */
export function isExcluded(path, folders) {
	if (!folders || folders.length === 0) return false;
	const lower = String(path ?? "").toLowerCase();
	for (const raw of folders) {
		const folder = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
		if (folder === "") continue;
		if (lower === folder || lower.startsWith(`${folder}/`)) return true;
	}
	return false;
}

function compare(a, b, sort) {
	switch (sort) {
		case "mtime":
			// Oldest edit first — the queue is a worklist, so the most neglected note is the
			// one you want at the top, whichever column you sorted by.
			return a.mtime - b.mtime;
		case "lastOpen":
			return a.lastOpen - b.lastOpen;
		case "effort":
			return b.editMs - a.editMs;
		case "score":
		default:
			return b.score - a.score;
	}
}

/** Sort a copy. Ties break by path so the order is stable across renders and across runs. */
export function sortQueue(rows, sort) {
	const key = QUEUE_SORTS.includes(sort) ? sort : "score";
	return [...rows].sort((a, b) => {
		const primary = compare(a, b, key);
		if (primary !== 0) return primary;
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});
}

/**
 * Filter the scored rows down to the ones worth reviewing, and rank them.
 *
 * `exempt` notes (evergreen, or snoozed) are dropped outright rather than sorted to the
 * bottom: a queue you have to scroll past 400 evergreen notes to use is not a queue.
 */
export function buildQueue(rows, opts) {
	const options = opts ?? {};
	const minScore = Number.isFinite(options.minScore) ? options.minScore : 0;
	const excludeFolders = options.excludeFolders ?? [];
	const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : Infinity;

	const kept = [];
	for (const row of rows ?? []) {
		if (!row || typeof row.path !== "string") continue;
		if (row.band === "exempt") continue;
		if (row.score < minScore) continue;
		if (isExcluded(row.path, excludeFolders)) continue;
		kept.push(row);
	}

	const sorted = sortQueue(kept, options.sort ?? "score");
	return limit === Infinity ? sorted : sorted.slice(0, limit);
}

/** RFC 4180 field: quote when the value could otherwise break the row, and double the quotes. */
function csvField(value) {
	const text = value === null || value === undefined ? "" : String(value);
	if (!/[",\r\n]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

const CSV_HEADERS = [
	"path",
	"score",
	"band",
	"halfLifeDays",
	"lastEditedISO",
	"lastOpenedISO",
	"newestInboundISO",
	"editMinutes",
	"revisions",
	"reasons",
];

function iso(ms) {
	return ms > 0 ? new Date(ms).toISOString() : "";
}

/**
 * The queue as CSV. Deterministic column order, ISO-8601 timestamps (never a locale format
 * — a CSV opened in another country must not silently reinterpret 03/04 as April 3rd), and
 * every field escaped, because note paths legitimately contain commas and quotes.
 */
export function toCsv(rows) {
	const lines = [CSV_HEADERS.join(",")];
	for (const row of rows ?? []) {
		lines.push(
			[
				csvField(row.path),
				csvField(row.score),
				csvField(row.band),
				csvField(row.halfLifeDays),
				csvField(iso(row.mtime)),
				csvField(iso(row.lastOpen)),
				csvField(iso(row.newestInboundMtime ?? 0)),
				csvField(Math.round((row.editMs ?? 0) / 60000)),
				csvField(row.revisions ?? 0),
				csvField((row.reasons ?? []).join(" ")),
			].join(",")
		);
	}
	return `${lines.join("\n")}\n`;
}
