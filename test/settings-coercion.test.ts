// A corrupt data.json must not be able to BRICK the plugin.
//
// THE BUG, VERBATIM. `refreshLicense()` runs `this.settings.licenseKey.trim()`, and it is
// awaited from `onload()` on line two. `loadSettings()` carefully coerced isPro,
// excludeFolders, snoozedUntil, halfLives, weights and bandThresholds — and not one string. So
// `{"licenseKey": 123}` in data.json (a bad sync merge, a hand-edit, a half-written file, any
// other tool with a JSON writer) throws `TypeError: this.settings.licenseKey.trim is not a
// function` INSIDE onload(). The plugin never finishes loading, which means its settings tab
// never renders, which means there is no way to fix the bad value from inside Obsidian. The
// user's only recovery is to find data.json in a hidden folder and edit JSON by hand.
//
// A wrong setting is a bug. A setting that prevents the plugin from loading is a support
// ticket, and it is the one failure mode a settings loader exists to prevent.
import assert from "node:assert";
import NoteDecayPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";

// The debounced save/rescore reach for `window`. Node has none.
(globalThis as Record<string, unknown>).window = {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: number) => clearTimeout(id),
	setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
	clearInterval: (id: number) => clearInterval(id),
};

const app = {
	vault: { getMarkdownFiles: () => [], on: () => ({}) },
	metadataCache: { resolvedLinks: {}, getFileCache: () => null, on: () => ({}) },
	workspace: { getActiveViewOfType: () => null, getLeavesOfType: () => [], on: () => ({}) },
};

function makePlugin(data: unknown): NoteDecayPlugin {
	const plugin = new NoteDecayPlugin(app as never, { id: "note-decay", version: "1.0.0" } as never);
	(plugin as unknown as { data: unknown }).data = data;
	return plugin;
}

async function main(): Promise<void> {
	// --- 1. the crash ------------------------------------------------------------
	{
		// Every string field, holding something that is not a string. This is the shape that
		// took the plugin down.
		const plugin = makePlugin({
			licenseKey: 123,
			licenseEmail: { at: "example.com" },
			licenseStatus: null,
			frontmatterKey: 7,
			defaultProfile: false,
			enginePath: ["/usr/bin/engine"],
			signalsWriterId: 42,
		});

		await plugin.loadSettings();

		for (const key of [
			"licenseKey",
			"licenseEmail",
			"licenseStatus",
			"frontmatterKey",
			"defaultProfile",
			"enginePath",
			"signalsWriterId",
		] as const) {
			assert.equal(
				typeof plugin.settings[key],
				"string",
				`settings.${key} must be a string after load — the code calls string methods on it`
			);
		}

		// The exact call that threw inside onload(). If this line does not throw, the plugin loads.
		await assert.doesNotReject(
			() => plugin.refreshLicense(),
			"onload() awaits refreshLicense(), which calls licenseKey.trim() — a non-string there is a plugin that cannot start"
		);
		assert.equal(plugin.settings.isPro, false, "and garbage still does not buy Pro");

		// A garbage key must not silently become a garbage frontmatter key, either: the profile
		// reader would then look for `7:` in every note's YAML.
		assert.equal(plugin.settings.frontmatterKey, DEFAULT_SETTINGS.frontmatterKey);
		assert.equal(plugin.settings.defaultProfile, DEFAULT_SETTINGS.defaultProfile);
		assert.ok(plugin.settings.signalsWriterId.length > 0, "a fresh shard id is minted for the log");
	}

	// --- 2. the silent sibling: a non-numeric snoozeDays ---------------------------
	// `Date.now() + "x" * DAY_MS` is NaN, and `snoozedUntil[path] = NaN` compares false against
	// every timestamp forever — so "Snooze this note" reports success and does nothing at all.
	{
		const plugin = makePlugin({ snoozeDays: "thirty", queueMinScore: null });
		await plugin.loadSettings();

		assert.equal(plugin.settings.snoozeDays, DEFAULT_SETTINGS.snoozeDays);
		assert.equal(plugin.settings.queueMinScore, DEFAULT_SETTINGS.queueMinScore);

		await plugin.snooze("rotting.md");
		const until = plugin.settings.snoozedUntil["rotting.md"];
		assert.ok(
			Number.isFinite(until) && until > Date.now(),
			`a snooze must land in the future, not on NaN (got ${until})`
		);
	}

	// --- 3. the honest case still works -------------------------------------------
	{
		const plugin = makePlugin({ licenseKey: "  abc.def  ", excludeFolders: ["Archive", 9, null] });
		await plugin.loadSettings();
		assert.equal(plugin.settings.licenseKey, "  abc.def  ", "a real key is untouched, whitespace and all");
		assert.deepEqual(plugin.settings.excludeFolders, ["Archive"], "and the non-strings are dropped, not stringified");
	}
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
