// The gate ENGINE, exercised against this plugin's table. features.test.mjs pins WHICH
// features are Pro; this pins how the gate behaves when it is asked — including the two
// failure modes that would quietly give away the paywall or quietly break the free tier.
import assert from "node:assert";
import { FEATURES } from "../src/core/features.mjs";
import {
	isFeatureEnabled,
	needsEngine,
	proFeatureKeys,
	featureFreeLimit,
	withinFreeLimit,
} from "../src/shared/featureGates.mjs";

// An UNKNOWN key is free, not accidentally paywalled. A typo in a call site must degrade
// to "the feature works" — a typo that silently locks a free feature is a bug the user
// reports as "the plugin is broken", and we would never find it.
assert.equal(isFeatureEnabled(FEATURES, "nonexistent", false), true);
assert.equal(isFeatureEnabled(FEATURES, "nonexistent", true), true);
assert.equal(needsEngine(FEATURES, "nonexistent"), false);

// isPro is compared by IDENTITY to true. A truthy-but-not-true value out of a corrupt
// data.json ("yes", 1, {}) must not unlock Pro.
for (const notTrue of ["true", 1, {}, [], "yes"]) {
	assert.equal(
		isFeatureEnabled(FEATURES, "topicGroups", notTrue),
		false,
		`a truthy non-boolean (${JSON.stringify(notTrue)}) must not unlock Pro`
	);
}
assert.equal(isFeatureEnabled(FEATURES, "topicGroups", true), true);

// A free feature is enabled regardless of what is passed for isPro — there is nothing to
// get wrong there, and the free tier must never depend on the license path running first.
for (const anything of [true, false, undefined, null, 0]) {
	assert.equal(isFeatureEnabled(FEATURES, "score", anything), true);
	assert.equal(isFeatureEnabled(FEATURES, "reviewQueue", anything), true);
}

// proFeatureKeys is in DECLARATION order — the Pro card renders it verbatim, so a stable
// order is a UI contract, not an implementation detail.
assert.deepEqual(proFeatureKeys(FEATURES), ["topicGroups", "superseded"]);

// Patina has no metered features: nothing is capped for free users, so every free
// limit is unlimited and `withinFreeLimit` is always true. This is asserted rather than
// assumed, because a cap that appeared by accident would be a silent product change.
for (const key of Object.keys(FEATURES)) {
	assert.equal(featureFreeLimit(FEATURES, key), Infinity, `${key} must not be metered`);
}
assert.equal(withinFreeLimit(FEATURES, "reviewQueue", 100_000, false), true);

console.log("ok  feature-gates.test.mjs");
