// The copy shown when a Pro feature CANNOT run.
//
// This is not a string test. The failure it guards against is the one the whole "degrade
// honestly" rule exists for: a paying user clicks "Find superseded notes", the engine is not
// installed, and the add-on shows an empty list. An empty list means "your vault is clean".
// The truth was "this feature did not run". Those are opposite claims and they look identical.
//
// So: every block must SAY it could not run, must never say "no"/"none"/"nothing found", and
// the install directory the consent modal prints must be the real one (DESIGN 7.1) — outside
// the vault, on every platform.
import assert from "node:assert";
import {
	EMPTY_SUPERSEDED,
	EMPTY_TOPIC_GROUPS,
	blockCopy,
	engineInstallDir,
} from "../src/core/engineCopy.mjs";

const FEATURE = "Superseded-note detection";

const BLOCKS = [
	{ kind: "not-pro" },
	{ kind: "desktop-only" },
	{ kind: "unsupported", message: "no build for freebsd/arm" },
	{ kind: "not-published" },
	{ kind: "not-installed" },
	{ kind: "failed", message: "The engine exited (code 1)." },
];

for (const block of BLOCKS) {
	const copy = blockCopy(block, FEATURE);
	assert.ok(copy.length > 0, `${block.kind} must have copy`);
	assert.ok(copy.includes(FEATURE), `${block.kind}: the copy must name the feature that did not run`);

	// The sentence a user must NEVER read from a blocked feature.
	assert.ok(
		!/\bno (superseded|topics|results|findings)\b/i.test(copy),
		`${block.kind}: a blocked feature must not report a finding — it found nothing because it did not run`
	);
	assert.ok(!/\bnothing found\b/i.test(copy), `${block.kind}: same`);
	assert.ok(!/\b0 (notes|results)\b/i.test(copy), `${block.kind}: same`);
}

// The one blocked state with something to do about it says what will happen BEFORE it happens:
// a program is downloaded and run, and the user gets to see the URL and the checksum first.
const install = blockCopy({ kind: "not-installed" }, FEATURE);
assert.match(install, /never sends anything over the network/);
assert.match(install, /checksum/);
assert.match(install, /nothing happens until you click/i);

// Mobile is not a paywall, and the copy must not read like one.
const mobile = blockCopy({ kind: "desktop-only" }, FEATURE);
assert.match(mobile, /desktop only/);
assert.match(mobile, /Everything else in this add-on/);
assert.ok(!/\$29|buy|purchase|upgrade/i.test(mobile), "a Pro user on a phone is not being upsold");

// The unpublished-engine state is the one that ships TODAY (ENGINE_RELEASE_PINNED is false),
// so it is the one a real buyer would hit. It must say the feature is off, not that it is empty.
const unpublished = blockCopy({ kind: "not-published" }, FEATURE);
assert.match(unpublished, /has not been published/);
assert.match(
	unpublished,
	/switched off rather than shown empty/,
	"it explains WHY it shows nothing rather than quietly showing an empty list"
);

// --- the install directory (DESIGN 7.1) --------------------------------------
// NEVER inside the vault: "a note app dropped an .exe into a documents folder and ran it" is
// the EDR escalation pattern, and Obsidian Sync would replicate 100 MB to the user's phone.
assert.equal(engineInstallDir("win-x64", "1.0.0"), "%LOCALAPPDATA%\\second-read-engine\\bin\\1.0.0");
assert.equal(
	engineInstallDir("macos-arm64", "1.0.0"),
	"~/Library/Application Support/second-read-engine/bin/1.0.0"
);
assert.match(engineInstallDir("linux-x64", "1.0.0"), /^\$XDG_DATA_HOME\/second-read-engine/);
for (const target of ["win-x64", "macos-arm64", "macos-x64", "linux-x64"]) {
	const dir = engineInstallDir(target, "1.0.0");
	assert.ok(!/\.obsidian/.test(dir), "the engine never lands in the vault's config dir");
	assert.ok(dir.includes("second-read-engine"), "…and it is the SUITE's directory, not this add-on's");
	assert.ok(dir.endsWith("1.0.0"), "…versioned, so an update cannot half-overwrite a running engine");
}

// The empty states — the ones shown only AFTER the engine actually ran — say the opposite
// thing, in words, on purpose.
assert.match(EMPTY_SUPERSEDED, /Nothing is superseded/);
assert.match(EMPTY_TOPIC_GROUPS, /ungrouped, not empty/);

console.log("ok  engine-copy.test.mjs");
