import { SUITE_PRODUCT_ID } from "./shared/suiteLicense.mjs";

/**
 * This plugin's identity, and its binding to the SUITE license.
 *
 * The two are deliberately different namespaces. `PRODUCT_ID` is the manifest id — what
 * Obsidian calls this add-on. `LICENSE_PRODUCT_ID` is what a key is signed for, and it is
 * the same string in all five Second Read add-ons, so one purchase unlocks all of them.
 * A key minted for "patina" is NOT a Second Read key and must never verify; that is
 * asserted in test/license.test.mjs.
 */

/** This plugin's manifest id. NOT the license product id. */
export const PRODUCT_ID = "patina";
export const PRODUCT_NAME = "Patina";

/** What a license key is signed for. Shared by all five Second Read add-ons. */
export const LICENSE_PRODUCT_ID = SUITE_PRODUCT_ID; // "second-read"

export const SUITE_NAME = "Second Read";
export const PRO_NAME = "Second Read Pro";
export const PRO_PRICE_LABEL = "$29 one-time";

/**
 * THE PURCHASE SWITCH. One constant; everything else is derived from it.
 *
 * It is `null`, and that is not an oversight — the Second Read suite checkout DOES NOT EXIST
 * YET (DESIGN 4.7 / Open Question 10.2: Buy Me a Coffee cannot auto-deliver a signed key, so
 * the processor has to move to Lemon Squeezy or Polar before launch). While it is null the
 * add-on renders the Pro features and the price, and says plainly that purchasing is not open
 * — it does NOT render a buy button.
 *
 * The button it used to render pointed at `buymeacoffee.com/vaultspotlight`: a generic tip jar
 * for a DIFFERENT product, which takes the user's $29, sends them nothing, and cannot even
 * tell the author what they bought. A dead link is a bad button; a link that takes money for a
 * product it does not deliver is a worse one.
 *
 * TO OPEN THE CHECKOUT: paste the URL here. One edit. `PURCHASE_AVAILABLE`, the settings card,
 * the upsell modal, the inline upgrade links and `manifest.fundingUrl` all follow from it — and
 * `test/purchase.test.ts` asserts that they do, in both states.
 */
export const PURCHASE_URL: string | null = null;

/** True once a real checkout exists. The ONLY thing any CTA may branch on. */
export const PURCHASE_AVAILABLE: boolean =
	typeof PURCHASE_URL === "string" && (PURCHASE_URL as string).length > 0;

/** What a Pro card says instead of a buy button while the checkout is not open. */
export const PURCHASE_PENDING_LABEL = "Purchasing opens soon";

export const PURCHASE_PENDING_COPY =
	`${PRO_NAME} is not on sale yet — the suite launches with all five add-ons and a checkout ` +
	"that emails your key automatically. Nothing here is a trial and nothing expires: the free " +
	"tier below is the whole add-on minus the two semantic features. If you already have a key, " +
	"paste it above.";

export const PRO_TAGLINE =
	"One key unlocks Pro in all five Second Read add-ons: Patina, Standing Questions, Effort Index, Prior Art, and Unwritten. $29 one-time, no subscription, no account.";

/** What a free user of THIS add-on is missing, in one phrase. */
export const PRO_UNLOCK_SUMMARY = "topic-grouped review sessions and superseded-note detection";

/** Contextual upsell copy, keyed by the feature the user reached for. */
export const PRO_UPSELL: Record<string, string> = {
	topicGroups: "Grouping the review queue by topic is a Pro feature. " + PRO_TAGLINE,
	superseded: "Superseded-note detection is a Pro feature. " + PRO_TAGLINE,
};
