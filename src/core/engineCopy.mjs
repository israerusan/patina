/**
 * The copy the add-on shows when a semantic Pro feature CANNOT run, and the install path it
 * names when offering to fix that. PURE — no `obsidian`, no Node, no engine handle.
 *
 * This file exists because the honest half of a paywalled feature is the half that says why
 * it did nothing. Every one of these strings is on a path a paying user can reach, and the
 * one thing none of them may do is imply that the feature RAN and found nothing: an empty
 * result list and an engine that is not installed look identical in a sidebar, and only one
 * of them means "your vault is fine".
 */

/** Where the shared engine lands, per target (DESIGN 7.1). NEVER inside the vault. */
export const ENGINE_HOME_LABEL = Object.freeze({
	"win-x64": "%LOCALAPPDATA%\\second-read-engine",
	"macos-arm64": "~/Library/Application Support/second-read-engine",
	"macos-x64": "~/Library/Application Support/second-read-engine",
	"linux-x64": "$XDG_DATA_HOME/second-read-engine (usually ~/.local/share)",
});

/**
 * The directory the consent modal prints as "Installs to", written the way the user's own
 * shell would write it.
 *
 * It is deliberately the ENV-VAR form rather than an expanded absolute path: expanding it
 * would mean reaching for Node (`os.homedir()`) from plugin code, and this string is shown to
 * a user who is about to let an add-on download and run a binary — "%LOCALAPPDATA%\..." is
 * something they can check against their own machine without trusting us to have resolved it
 * correctly.
 */
export function engineInstallDir(target, version) {
	const home = ENGINE_HOME_LABEL[String(target)] ?? "the add-on's engine directory";
	const sep = String(target).startsWith("win-") ? "\\" : "/";
	return `${home}${sep}bin${sep}${String(version)}`;
}

/**
 * Why a semantic feature cannot run, in one paragraph, for each way it can be unavailable.
 * `feature` is the human label ("Group the queue by topic"), not a key.
 */
export function blockCopy(block, feature) {
	switch (block?.kind) {
		case "not-pro":
			return `${feature} is a Pro feature.`;
		case "desktop-only":
			return (
				`${feature} needs the semantic engine, which runs on desktop only. ` +
				"Everything else in this add-on — scoring, the review queue, snoozing, CSV export — works here."
			);
		case "unsupported":
			return (
				`${feature} needs the semantic engine, and there is no engine build for this computer. ` +
				"You can point the add-on at an engine you built yourself under Settings → Semantic engine. " +
				"Nothing else in this add-on is affected."
			);
		case "not-published":
			return (
				`${feature} needs the semantic engine, and the engine has not been published yet — ` +
				"so there is nothing to download and this feature cannot run in this release. " +
				"It is switched off rather than shown empty: an empty list would look like a clean " +
				"vault, and that would be a lie. Everything else in this add-on works now."
			);
		case "not-installed":
			return (
				`${feature} needs the semantic engine, which is not installed yet. ` +
				"The engine is a program that runs on your computer and never sends anything over the " +
				"network; you will be shown its exact download URL, version, and checksum before anything " +
				"is downloaded, and nothing happens until you click through that."
			);
		case "failed":
			return `${feature} could not run: ${String(block.message ?? "the engine did not start.")}`;
		default:
			return `${feature} could not run.`;
	}
}

/** The empty state AFTER the engine actually ran. Distinct from every block above, on purpose. */
export const EMPTY_TOPIC_GROUPS =
	"The engine compared every note in the queue and found no topic shared by two or more of them. " +
	"The queue is ungrouped, not empty.";

export const EMPTY_SUPERSEDED =
	"The engine compared every note in the queue against every newer note in the vault and found " +
	"nothing that a newer note has replaced. Nothing is superseded.";
