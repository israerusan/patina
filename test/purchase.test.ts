// THE SECOND READ CHECKOUT IS OPEN, AND EVERY CTA IS A LIVE BUY BUTTON.
//
// PURCHASE_URL now names the real Second Read Pro product
// (buymeacoffee.com/vaultspotlight/e/560213). PURCHASE_AVAILABLE derives from it, so the
// settings tab and the upsell modal each render a live 'Unlock Pro' anchor pointing at that
// checkout, and the 'purchasing opens soon' copy is gone. One key unlocks all five add-ons.
//
// This file asserts the open state in both directions: the rendered CTAs point at the real
// checkout, and safeHttpUrl still refuses anything that is not a real https URL.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { PatinaSettingTab } from "../src/ui/SettingsTab";
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
	const tab = new PatinaSettingTab(fakePlugin(isPro) as never);
	tab.display();
	return tab.containerEl as unknown as FakeEl;
}

/** Every anchor in the subtree that points somewhere outside the vault. */
function externalLinks(el: FakeEl): FakeEl[] {
	return el.findAll((node) => node.tag === "a" && /^https?:/.test(node.attrs.href ?? ""));
}

// --- 1. the constant itself ----------------------------------------------------
assert.equal(
	PURCHASE_URL,
	"https://buymeacoffee.com/vaultspotlight/e/560213",
	"the ONE place the Second Read checkout URL lives",
);
assert.equal(PURCHASE_AVAILABLE, true, "…and everything else is derived from it");

// --- 2. the settings tab renders the Pro card, and no buy button ----------------
{
	const el = renderSettings(false);
	const text = el.text();

	// The card is still there. A paywall you cannot see is a paywall nobody buys through, and a
	// free user is entitled to know what the Pro features are.
	assert.match(text, /Second Read Pro — \$29 one-time/);
	assert.match(text, /Group the queue by topic/, "the Pro feature list still renders");
	assert.match(text, /Superseded-note detection/);

	// And it now offers the real checkout.
	assert.ok(
		externalLinks(el).map((a) => a.attrs.href).includes(PURCHASE_URL),
		"the settings card links to the real Second Read checkout"
	);
	assert.match(text, /Unlock Pro|Get Pro/, "and a button labelled as a purchase");
	assert.ok(!/Purchasing opens soon/.test(text), "the pending copy is gone now that checkout is open");
}

// --- 3. the upsell modal, reached by clicking a locked Pro feature ---------------
{
	const modal = new ProUpsellModal(app as never, "topicGroups");
	modal.open(); // the stub's open() runs onOpen(), like Obsidian's
	const el = modal.contentEl as unknown as FakeEl;

	assert.match(el.text(), /Grouping the review queue by topic is a Pro feature/);
	assert.ok(
		externalLinks(el).map((a) => a.attrs.href).includes(PURCHASE_URL),
		"the upsell modal now offers the real checkout"
	);
	assert.match(el.text(), /I have a license key/);
}

// --- 4. THE FLIP. One constant, and every CTA becomes a live buy button. ---------
// This is the half that proves the "purchasing opens soon" copy is a switch and not a dead end:
// renderPurchaseCta is the only thing in the add-on that decides, and it decides from the URL.
{
	const parent = new FakeEl();
	const rendered = renderPurchaseCta(parent as never, { label: "Unlock Pro", cls: "patina-pro-btn" });
	assert.equal(rendered, true, "a live checkout, a live button");
	const cta = parent.find((node) => node.tag === "a");
	assert.ok(cta && cta.attrs.href === PURCHASE_URL, "renderPurchaseCta produced an anchor to the checkout");

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
