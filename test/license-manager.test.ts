// THE PLUGIN'S VERIFY PATH MUST BE THE SUITE'S VERIFY PATH — AND IT MUST REJECT A REVOKED KEY.
//
// THE DRIFT, VERBATIM: `src/license/LicenseManager.ts` hand-rolled the revoke-then-verify
// composition (`isRevoked(key)` then `verifyLicense(key, SUITE_PRODUCT_ID, PUBLIC_KEY)`) even
// though `shared/suiteLicense.mjs` exports `verifySuiteLicense()`, which documents itself as
// "THE ONE FUNCTION THAT DECIDES WHETHER A KEY UNLOCKS PRO. Every plugin calls this and nothing
// else" — and which exists precisely because that composition "used to be hand-copied into five
// src/license/LicenseManager.ts files that no test, no linter and no drift check ever compared".
// The copy was behaviourally identical, so nothing was broken TODAY. That is what makes it
// dangerous: with one suite keypair, the by-value denylist is the only mechanism that can kill a
// leaked key, and a plugin that loses its `isRevoked` call in some later edit keeps unlocking Pro
// for a revoked key, silently, forever. Nothing compared the five copies. Now nothing has to:
// there is only one.
//
// WHY THIS TEST IS NOT VACUOUS. The obvious revocation test — take a string, revoke it, assert it
// does not unlock Pro — passes against a LicenseManager with NO revocation check at all, because
// the string fails the signature check anyway. It proves nothing. So the key used below carries a
// GENUINELY VALID Ed25519 signature over `product: "second-read"`: block 1 asserts it unlocks Pro
// while the denylist is empty. Only then is a rejection in block 2 attributable to revocation.
//
// (The signature is valid under an EPHEMERAL keypair minted in this process — never under the
// shipped public key, which no repo but obsidian-plugin-core can sign for. The `deps` seam that
// `verifySuiteLicense` exposes for exactly this purpose points the real verifier at the ephemeral
// public half; the crypto is real, only the keypair is throwaway. A key signed for the production
// keyspace must not exist in a plugin repo in any form — one did once, in public.)
import assert from "node:assert";
import nacl from "tweetnacl";
import { LicenseManager } from "../src/license/LicenseManager";
import { verifyLicense } from "../src/shared/verifyLicense.mjs";
import { SUITE_PRODUCT_ID, verifySuiteLicense } from "../src/shared/suiteLicense.mjs";

const failures: string[] = [];

/** Run every block, report every failure — one pre-fix run should show the whole picture. */
function block(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`    ok  ${name}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		failures.push(`${name}\n${message}`);
		console.log(`  FAIL  ${name}`);
	}
}

const b64url = (bytes: Uint8Array) =>
	Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const throwaway = nacl.sign.keyPair();
const throwawayPublicKey = Buffer.from(throwaway.publicKey).toString("base64");

/** A real Ed25519 license key for the real suite product id, signed with a throwaway key. */
function mint(payload: Record<string, string>): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	return `${b64url(bytes)}.${b64url(nacl.sign.detached(bytes, throwaway.secretKey))}`;
}

const leaked = mint({ product: SUITE_PRODUCT_ID, email: "leaked@example.com", issued: "2026-07-14" });

/** Calls of the injected verifier, so a test can prove the denylist ran BEFORE the crypto. */
let signatureChecks = 0;

/**
 * The production dependencies, with two swaps: the REAL verifier pointed at the throwaway public
 * key (so `leaked` is a genuinely valid signature), and a denylist under the test's control.
 */
function deps(revoked: string[]) {
	return {
		isRevoked: (key: string) => revoked.includes(key),
		verifyLicense: (key: string, product: string) => {
			signatureChecks++;
			return verifyLicense(key, product, throwawayPublicKey);
		},
	};
}

// 1. THE CONTROL. Not a revocation test — the test that makes the revocation test mean something.
//    This key really does unlock Pro. Whatever rejects it in block 2 can only be the denylist.
block("a genuinely valid suite key unlocks Pro while the denylist is empty", () => {
	const result = LicenseManager.verify(leaked, deps([]));
	assert.equal(
		result.valid,
		true,
		`the plugin's verify path must accept a real signature over product "${SUITE_PRODUCT_ID}" ` +
			"(if this fails, LicenseManager is not routing through verifySuiteLicense at all, and " +
			"the revocation assertions below prove nothing)"
	);
	assert.equal(result.email, "leaked@example.com");
	assert.equal(signatureChecks, 1, "the signature was actually checked");
});

// 2. THE ONE THAT MATTERS. Same key, same valid signature, now on the denylist by value.
block("a REVOKED key does not unlock Pro, even with a perfectly valid signature", () => {
	const result = LicenseManager.verify(leaked, deps([leaked]));
	assert.equal(result.valid, false, "a revoked key must not unlock Pro");
	assert.equal(
		result.error,
		"This key has been revoked. Contact support for a replacement.",
		"it must be rejected BY REVOCATION — an 'invalid signature' rejection here would mean the " +
			"key never reached the denylist, and the plugin's revocation branch never ran"
	);
});

// 3. ORDER. Revocation is checked before the signature — not merely alongside it. A rejection
//    that depends on the crypto also running is a rejection a later early-return can lose.
//
//    NOTE the first half. "The signature check was not reached" is trivially true of a verify
//    path that never calls the injected verifier at ALL — which is how a LicenseManager that
//    ignores `deps` would pass this block while doing none of what it claims. So prove the
//    counter is live (it moves for a key that is NOT revoked) before reading anything into a
//    zero.
block("revocation short-circuits: a revoked key never reaches the signature check", () => {
	signatureChecks = 0;
	LicenseManager.verify(leaked, deps([]));
	assert.equal(signatureChecks, 1, "the counter is live: a non-revoked key DOES reach the signature check");

	signatureChecks = 0;
	const result = LicenseManager.verify(leaked, deps([leaked]));
	assert.equal(result.valid, false);
	assert.equal(signatureChecks, 0, "and no crypto may run for a key that is already revoked");
});

// 4. The denylist is by VALUE, and the value is the trimmed key — a pasted key with a stray
//    newline is the same key, and revoking it must revoke that too.
block("a revoked key stays revoked when it arrives with surrounding whitespace", () => {
	const result = LicenseManager.verify(`\n  ${leaked}\t `, deps([leaked]));
	assert.equal(result.valid, false, "trim happens inside the one shared function, before the lookup");
	assert.equal(result.error, "This key has been revoked. Contact support for a replacement.");
});

// 5. STRUCTURAL. `LicenseManager.verify` is not a copy of the suite verifier, and not a wrapper
//    that could grow one — it IS the shared function, by reference. This is the assertion that a
//    future hand-rolled re-implementation fails, even a byte-perfect one.
block("LicenseManager.verify IS verifySuiteLicense — the composition is never re-implemented", () => {
	assert.equal(
		LicenseManager.verify,
		verifySuiteLicense,
		"LicenseManager must re-export the shared verifier, not compose isRevoked + verifyLicense itself"
	);
});

// 6. And the production path — no deps, real denylist, real shipped public key — still fails
//    closed on a key from a foreign keyspace. `leaked` is signed by a throwaway keypair, so
//    against the REAL public key it is exactly what an attacker's forgery is: a bad signature.
block("with no test seam, a key signed by a foreign keypair is rejected against the shipped key", () => {
	const result = LicenseManager.verify(leaked);
	assert.equal(result.valid, false);
	assert.equal(result.error, "Invalid license signature.");
});

if (failures.length > 0) {
	throw new assert.AssertionError({
		message: `license-manager.test.ts: ${failures.length} block(s) failed\n\n${failures.join("\n\n")}`,
	});
}
