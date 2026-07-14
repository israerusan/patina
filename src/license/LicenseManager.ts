import { verifySuiteLicense } from "../shared/suiteLicense.mjs";

export type { LicensePayload, LicenseVerification } from "../shared/verifyLicense.mjs";
export type { SuiteLicenseDeps } from "../shared/suiteLicense.mjs";

/** Same function, same reference — for a call site that would rather skip the class. */
export { verifySuiteLicense };

/**
 * The plugin's license entry point. It is a RE-EXPORT of the shared suite verifier — not a
 * copy of it, and not even a wrapper around it.
 *
 * WHAT USED TO BE HERE. This class hand-rolled the composition: `isRevoked(key)`, then
 * `verifyLicense(key, SUITE_PRODUCT_ID, SUITE_LICENSE_PUBLIC_KEY)`. So did the other four
 * add-ons, in five files that no test, no linter and no drift check ever compared. It was
 * correct in all five — on the day it was written. With a single suite keypair the by-value
 * denylist is the ONLY mechanism that can kill a leaked key (rotating the keypair would revoke
 * Pro for every paying customer at once), so one plugin quietly losing its `isRevoked` call in
 * some later edit means a revoked key keeps unlocking Pro there, silently, forever — a bug no
 * reviewer would catch, because the code would still LOOK like it verifies a signature, and it
 * would.
 *
 * `verifySuiteLicense` is that composition, written once, vendored byte-identically into all
 * five repos by `npm run sync:shared` and pinned by MANIFEST.sha256. Binding it straight onto
 * `verify` instead of calling it from a method body is deliberate: `LicenseManager.verify` IS
 * the shared function, by reference, which `test/license-manager.test.ts` asserts — so a future
 * re-implementation fails the suite loudly even if it is byte-for-byte correct. There is
 * nothing left in this file for the revocation check to fall out of.
 */
export class LicenseManager {
	/** @see verifySuiteLicense — revocation by value, checked BEFORE the signature. */
	static readonly verify: typeof verifySuiteLicense = verifySuiteLicense;
}
