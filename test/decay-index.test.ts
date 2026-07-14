// The WIRING, end to end: a vault + a link graph + a signals index go in, ranked queue rows
// come out. decay.test.mjs proves the arithmetic; this proves the arithmetic is actually
// connected to Obsidian's data — which is the half that silently breaks.
//
// DecayIndex imports only TYPES from `obsidian`, so there is no runtime dependency to stub:
// esbuild erases the import and this runs against a plain object shaped like an App.
import assert from "node:assert";
import { DecayIndex } from "../src/decayIndex";
import { buildQueue } from "../src/core/queue.mjs";
import { DEFAULT_SETTINGS, type NoteDecaySettings } from "../src/settings";
import type { SignalsIndex } from "../src/shared/signals/signalsAggregate.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-14T00:00:00.000Z");
const ago = (days: number) => NOW - days * DAY;

interface FakeFile {
	path: string;
	basename: string;
	extension: string;
	stat: { mtime: number; ctime: number };
}

function file(path: string, mtimeDays: number, ctimeDays = mtimeDays): FakeFile {
	const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
	return {
		path,
		basename,
		extension: "md",
		stat: { mtime: ago(mtimeDays), ctime: ago(ctimeDays) },
	};
}

function fakeApp(files: FakeFile[], resolvedLinks: Record<string, Record<string, number>>, frontmatter: Record<string, Record<string, unknown>> = {}) {
	return {
		vault: { getMarkdownFiles: () => files },
		metadataCache: {
			resolvedLinks,
			getFileCache: (f: FakeFile) => ({ frontmatter: frontmatter[f.path] }),
		},
	};
}

const settings: NoteDecaySettings = { ...DEFAULT_SETTINGS, excludeFolders: ["Archive"] };

const files = [
	file("fresh.md", 1),
	file("rotting.md", 400), // ancient, nothing links to it
	file("linked.md", 400, 400), // ancient, but a fresh note links to it
	file("evergreen.md", 900),
	file("Archive/old.md", 900),
];

const resolvedLinks = {
	// A note edited yesterday still points at linked.md — so its INBOUND signal is fresh
	// even though the note itself has not been touched in over a year.
	"fresh.md": { "linked.md": 1 },
};

const signals: SignalsIndex = {
	// Opened yesterday. The only note in the vault we have ever seen opened.
	"fresh.md": {
		firstSeen: ago(400),
		lastOpen: ago(1),
		opens: 12,
		editMs: 3_600_000,
		editSessions: 4,
		revisions: 2,
		lastEdit: ago(1),
		dwellMs: 0,
	},
	// Never opened, but we HAVE known about it for a long time — so `firstSeen` is what the
	// open-signal is measured from. (Never from 0; that is the install-day bug.)
	"rotting.md": {
		firstSeen: ago(400),
		lastOpen: 0,
		opens: 0,
		editMs: 7_200_000,
		editSessions: 9,
		revisions: 5,
		lastEdit: ago(400),
		dwellMs: 0,
	},
};

// esbuild emits CJS for the test bundle, and CJS has no top-level await. Everything that
// awaits lives in main().
async function main(): Promise<void> {
	const index = new DecayIndex(fakeApp(files, resolvedLinks, { "evergreen.md": { decay: "evergreen" } }) as never);
	await index.loadSignals(async () => signals);
	index.rebuild(settings, NOW);

	// --- the ancient, unlinked, never-opened note is the most decayed thing here ---
	const rotting = index.get("rotting.md");
	assert.ok(rotting, "rotting.md must be scored");
	assert.equal(rotting.band, "decayed");
	assert.ok(rotting.score >= 85, `expected a decayed score, got ${rotting.score}`);
	assert.ok(
		rotting.reasons.some((r) => r.includes("Never opened")),
		"the reasons must say WHY, not just how much"
	);
	// Effort Index's aggregate came through the SHARED log, with no dependency between the
	// plugins. This is the free cross-plugin bonus, and it is either wired or it is not.
	assert.equal(rotting.editMs, 7_200_000, "editMs comes from the shared signals store");
	assert.equal(rotting.revisions, 5);

	// --- an inbound link from a FRESH note keeps an ancient note off the worst rank ---
	// Both notes were last edited 400 days ago. The only difference is that something still
	// points at linked.md. If the resolvedLinks wiring were broken, these two would score the
	// same — which is exactly the regression this asserts against.
	const linked = index.get("linked.md");
	assert.ok(linked, "linked.md must be scored");
	assert.equal(linked.newestInboundMtime, ago(1), "inbound recency is the newest LINKING note's mtime");
	assert.ok(
		linked.score < rotting.score,
		`a note something still links to must decay slower (${linked.score} vs ${rotting.score})`
	);

	// --- the fresh note is fresh -------------------------------------------------
	const fresh = index.get("fresh.md");
	assert.ok(fresh && fresh.band === "fresh", `fresh.md should be fresh, got ${fresh?.band}`);

	// --- `decay: evergreen` in frontmatter exempts the note ----------------------
	const evergreen = index.get("evergreen.md");
	assert.ok(evergreen, "evergreen.md must still be scored (so the explorer can un-dim it)");
	assert.equal(evergreen.band, "exempt", "frontmatter must reach the scorer");
	assert.equal(evergreen.score, 0);

	// --- the queue drops the exempt and the excluded -----------------------------
	const queue = buildQueue(index.all(), {
		sort: settings.queueSort,
		minScore: settings.queueMinScore,
		excludeFolders: settings.excludeFolders,
	});
	const paths = queue.map((r) => r.path);
	assert.ok(!paths.includes("evergreen.md"), "an evergreen note never enters the queue");
	assert.ok(!paths.includes("Archive/old.md"), "an excluded folder never enters the queue");
	assert.ok(!paths.includes("fresh.md"), "a fresh note is below the minimum score");
	assert.equal(paths[0], "rotting.md", "the most decayed note is at the top of the worklist");

	// --- an unreadable activity log costs lastOpen, not the plugin ---------------
	const degraded = new DecayIndex(fakeApp(files, resolvedLinks) as never);
	// The store logs the failure on purpose; silence it so a PASSING run has a clean
	// transcript and a real stack trace in the output always means something.
	const realError = console.error;
	console.error = () => {};
	try {
		await degraded.loadSignals(async () => {
			throw new Error("the log is corrupt");
		});
	} finally {
		console.error = realError;
	}
	degraded.rebuild(settings, NOW);
	assert.equal(degraded.all().length, files.length, "a corrupt log must not empty the index");
	assert.ok(degraded.get("rotting.md"), "every note is still scored, just without open history");
}

// run.mjs `await import()`s this bundle but cannot await what the module body kicks off —
// CJS has no top-level await. So a rejected main() would otherwise print a stack trace and
// let the suite report "All tests passed" anyway. Exit non-zero, explicitly.
void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
