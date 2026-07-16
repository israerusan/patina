// The tier table (DESIGN 4.4 / 8.1). If one of these flips, someone has moved a feature
// across the paywall — a product decision, not a refactor, and it should fail the build
// until it is made deliberately.
import assert from "node:assert";
import { FEATURES } from "../src/core/features.mjs";
import { isFeatureEnabled, needsEngine, proFeatureKeys } from "../src/shared/featureGates.mjs";

// Free: the whole heuristic add-on. This is not a crippled demo — everything Patina
// does without the semantic engine works for nothing, forever, including on mobile.
const FREE = [
	"score",
	"explorerDim",
	"statusBar",
	"reviewQueue",
	"halfLifeProfiles",
	"snooze",
	"csvExport",
];
for (const key of FREE) {
	assert.equal(FEATURES[key].proOnly, false, `${key} must stay free`);
	assert.equal(FEATURES[key].engine, false, `${key} must never need the engine — mobile runs it`);
	assert.equal(isFeatureEnabled(FEATURES, key, false), true, `${key} must run for a free user`);
	assert.equal(needsEngine(FEATURES, key), false);
}

// Pro: the two SEMANTIC features. Both are proOnly AND engine — those are different
// conditions, and the UI must not conflate them (a mobile Pro user is not being paywalled).
for (const key of ["topicGroups", "superseded"]) {
	assert.equal(FEATURES[key].proOnly, true, `${key} must stay Pro`);
	assert.equal(FEATURES[key].engine, true, `${key} needs the semantic engine`);
	assert.equal(isFeatureEnabled(FEATURES, key, false), false);
	assert.equal(isFeatureEnabled(FEATURES, key, true), true);
	assert.equal(needsEngine(FEATURES, key), true);
}

// Every Pro key needs the engine, and every engine key is Pro. The suite's whole line is
// "free = heuristic, Pro = semantic"; a Pro feature that needs no engine would break it,
// and a free feature that needs one would break the mobile free tier.
assert.deepEqual(proFeatureKeys(FEATURES).sort(), ["superseded", "topicGroups"]);
for (const key of Object.keys(FEATURES)) {
	assert.equal(
		FEATURES[key].proOnly,
		FEATURES[key].engine,
		`${key}: Pro and engine must be the same set (free = heuristic, Pro = semantic)`
	);
}

// Every feature has a label. The settings tab and the Pro card render these strings.
for (const key of Object.keys(FEATURES)) {
	assert.equal(typeof FEATURES[key].label, "string");
	assert.ok(FEATURES[key].label.length > 0, `${key} must have a label`);
}

// The table is frozen: nothing can flip a gate at runtime.
assert.ok(Object.isFrozen(FEATURES));

console.log("ok  features.test.mjs");
