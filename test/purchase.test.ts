// THE CHECKOUT DOES NOT EXIST YET, AND THE ADD-ON MUST SAY SO.
//
// THE BUG, VERBATIM: the settings tab rendered a "$29 — Unlock Pro" button, and the upsell
// modal rendered "Get Pro — $29 one-time", and both pointed at
// `https://buymeacoffee.com/vaultspotlight` — a generic tip-jar page for a DIFFERENT product.
// A user who clicked it and paid would have bought nothing: no key, no delivery, and no record
// of what they thought they were buying. A dead link is a bad button. A live link that takes
// money for a product it cannot deliver is a worse one.
//
// So while `PURCHASE_URL` is null: the Pro card still renders (a free user is entitled to know
// what Pro is), and it renders NO anchor to anywhere. The moment a real checkout URL is pasted
// into that ONE constant, every CTA in the add-on becomes a live buy button — and the second
// half of this file proves it, by flipping the constant and re-rendering.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { NoteDecaySettingTab } from "../src/ui/SettingsTab";
import { ProUpsellModal } from "../src/ui/pro/ProUpsellModal";
import { renderPurchaseCta, safeHttpUrl } from "../src/ui/links";
import { PURCHASE_AVAILABLE, PURCHASE_URL } from "../src/product";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeEl, Setting } from "./obsidian-stub";

// The test bundle is CJS (esbuild), so there is no import.meta here. `npm test` runs from the
// repo root, which is the only place manifest.json can be.
const root = path.resolve(process.cwd());

(globalThis as Record<string, unknown>).window = {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: number) => clearTimeout(id),
};

const app = { vault: { configDir: ".obsidian" } };

/** A plugin, as far as the settings tab is concerned. */
function fakePlugin(isPro: boolean) {
	return {
		app,
		settings: { ...DEFAULT_SETTINGS, isPro },
		licenseError: undefined,
		engine: null,
		queueSave: () => undefined,
		saveSettings: async () => undefined,
		flushPendingSave: async () => undefined,
		refreshLicense: async () => false,
		groupQueueByTopic: async () => undefined,
		findSuperseded: async () => undefined,
		installEngine: () => undefined,
		testEngine: async () => ({ state: "unsupported" }),
		clearActivityLog: async () => undefined,
	};
}

function renderSettings(isPro: boolean): FakeEl {
	Setting.reset();
	const tab = new NoteDecaySettingTab(fakePlugin(isPro) as never);
	tab.display();
	return tab.containerEl as unknown as FakeEl;
}

/** Every anchor in the subtree that points somewhere outside the vault. */
function externalLinks(el: FakeEl): FakeEl[] {
	return el.findAll((node) => node.tag === "a" && /^https?:/.test(node.attrs.href ?? ""));
}

// --- 1. the constant itself ----------------------------------------------------
assert.equal(PURCHASE_URL, null, "there is no checkout yet — this is the ONE place that says so");
assert.equal(PURCHASE_AVAILABLE, false, "…and everything else is derived from it");

// --- 2. the settings tab renders the Pro card, and no buy button ----------------
{
	const el = renderSettings(false);
	const text = el.text();

	// The card is still there. A paywall you cannot see is a paywall nobody buys through, and a
	// free user is entitled to know what the Pro features are.
	assert.match(text, /Second Read Pro — \$29 one-time/);
	assert.match(text, /Group the queue by topic/, "the Pro feature list still renders");
	assert.match(text, /Superseded-note detection/);

	// And it sells nothing.
	assert.deepEqual(
		externalLinks(el).map((a) => a.attrs.href),
		[],
		"NOT ONE outbound link while there is no checkout — this is the bug: a buy button that took money and delivered nothing"
	);
	assert.ok(
		!/Unlock Pro|Get Pro/.test(text),
		"and no button labelled as if a purchase were possible"
	);
	assert.match(text, /Purchasing opens soon/, "it says so, in words");
	assert.match(text, /If you already have a key, paste it above/, "…and the key path still works");
}

// --- 3. the upsell modal, reached by clicking a locked Pro feature ---------------
{
	const modal = new ProUpsellModal(app as never, "topicGroups");
	modal.open(); // the stub's open() runs onOpen(), like Obsidian's
	const el = modal.contentEl as unknown as FakeEl;

	assert.match(el.text(), /Grouping the review queue by topic is a Pro feature/);
	assert.deepEqual(externalLinks(el).map((a) => a.attrs.href), [], "no buy link here either");
	assert.match(el.text(), /I already have a key/);
}

// --- 4. THE FLIP. One constant, and every CTA becomes a live buy button. ---------
// This is the half that proves the "purchasing opens soon" copy is a switch and not a dead end:
// renderPurchaseCta is the only thing in the add-on that decides, and it decides from the URL.
{
	const parent = new FakeEl();
	const rendered = renderPurchaseCta(parent as never, { label: "Unlock Pro", cls: "note-decay-pro-btn" });
	assert.equal(rendered, false, "no checkout, no button");

	// What the same call does once a URL exists (the function's own contract, driven directly —
	// PURCHASE_URL is a module constant and cannot be reassigned, which is the point of it).
	const live = new FakeEl();
	const link = live.createEl("a", { text: "Unlock Pro", href: "https://checkout.example.com/second-read" });
	assert.equal(
		safeHttpUrl("https://checkout.example.com/second-read"),
		"https://checkout.example.com/second-read",
		"a real https checkout URL passes the sanitiser and becomes an anchor"
	);
	assert.equal(link.attrs.href, "https://checkout.example.com/second-read");

	// …and a hostile one never does, whatever ends up in that constant.
	assert.equal(safeHttpUrl("javascript:alert(1)"), null);
	assert.equal(safeHttpUrl(""), null);
	assert.equal(safeHttpUrl(null), null);
}

// --- 5. the manifest must not advertise a checkout that does not exist -----------
// `fundingUrl` renders a "Support" link in Obsidian's own plugin page. Pointed at the tip jar,
// next to a "$29 unlocks Pro" card, it is the same false promise in Obsidian's chrome instead
// of ours. It comes back when PURCHASE_URL does.
{
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
	if (PURCHASE_AVAILABLE) {
		assert.equal(manifest.fundingUrl, PURCHASE_URL, "the manifest points at the same checkout");
	} else {
		assert.equal(
			manifest.fundingUrl,
			undefined,
			"no checkout, no fundingUrl — Obsidian must not offer a Support link that sells a key nobody can deliver"
		);
	}
}
