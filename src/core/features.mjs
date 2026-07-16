/**
 * Patina's tier table (DESIGN 4.4). The ENGINE that reads it lives in the vendored
 * shared core (`src/shared/featureGates.mjs`); the TABLE is per-plugin and lives here.
 *
 * `engine: true` means the feature needs the local semantic engine — which means desktop,
 * an installed engine, AND Pro. Those are three separate conditions and the UI must not
 * conflate them: a mobile Pro user is not being paywalled, they are being told the truth
 * about their device.
 *
 * Moving a key across `proOnly` is a product decision, not a refactor. features.test.mjs
 * pins this table so it fails the build until the change is made deliberately.
 */
export const FEATURES = Object.freeze({
	score: { proOnly: false, engine: false, label: "Staleness score" },
	explorerDim: { proOnly: false, engine: false, label: "Dim stale notes in the file list" },
	statusBar: { proOnly: false, engine: false, label: "Status-bar score" },
	reviewQueue: { proOnly: false, engine: false, label: "Review queue" },
	halfLifeProfiles: { proOnly: false, engine: false, label: "Per-type half-lives" },
	snooze: { proOnly: false, engine: false, label: "Snooze a note" },
	csvExport: { proOnly: false, engine: false, label: "Export as CSV" },
	topicGroups: { proOnly: true, engine: true, label: "Group the queue by topic" },
	superseded: { proOnly: true, engine: true, label: "Superseded-note detection" },
});
