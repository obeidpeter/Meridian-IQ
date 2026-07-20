import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  base32Encode,
  base32Decode,
  hotp,
  totpCode,
  totpStep,
  verifyTotpCode,
  generateTotpSecret,
  buildOtpauthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  issueMfaToken,
  verifyMfaToken,
  TOTP_STEP_SECONDS,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  MFA_TOKEN_TTL_MS,
} from "./totp.ts";
import { issueSessionToken, verifySessionToken } from "./session.ts";

// Hand-rolled RFC 6238 TOTP: pinned to the published test vectors so the
// implementation is provably interoperable with standard authenticator apps,
// plus the window/replay semantics the challenge route depends on. The mfa
// pending token shares the session signing secret but must be mutually
// unreadable with session tokens.

// The RFC 4226 / RFC 6238 SHA-1 test key: ASCII "12345678901234567890".
const RFC_KEY = Buffer.from("12345678901234567890", "ascii");
const RFC_KEY_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("base32 encodes the RFC test key exactly and round-trips random buffers", () => {
  assert.equal(base32Encode(RFC_KEY), RFC_KEY_B32);
  assert.deepEqual(base32Decode(RFC_KEY_B32), RFC_KEY);
  // Presentation tolerance: lowercase, whitespace and padding still decode.
  assert.deepEqual(base32Decode("gezd gnbv gy3t qojq GEZDGNBVGY3TQOJQ=="), RFC_KEY);
  for (const len of [1, 2, 3, 4, 5, 19, 20, 32]) {
    const buf = randomBytes(len);
    assert.deepEqual(
      base32Decode(base32Encode(buf)),
      buf,
      `round-trip at ${len} bytes`,
    );
  }
  assert.throws(() => base32Decode("not!base32"));
});

test("HOTP matches the RFC 4226 6-digit vectors", () => {
  // RFC 4226 Appendix D, truncated to 6 digits.
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676"];
  expected.forEach((code, counter) => {
    assert.equal(hotp(RFC_KEY, counter), code, `counter ${counter}`);
  });
});

test("TOTP matches the RFC 6238 SHA-1 vectors (mod 10^6)", () => {
  // RFC 6238 Appendix B (SHA-1 rows are 8-digit; ours is the same dynamic
  // truncation mod 10^6, i.e. the vector's last six digits).
  const vectors: Array<[number, string]> = [
    [59_000, "287082"], // 94287082
    [1_111_111_109_000, "081804"], // 07081804
    [1_111_111_111_000, "050471"], // 14050471
    [1_234_567_890_000, "005924"], // 89005924
    [2_000_000_000_000, "279037"], // 69279037
  ];
  for (const [epochMs, code] of vectors) {
    assert.equal(totpCode(RFC_KEY_B32, epochMs), code, `T=${epochMs / 1000}s`);
  }
});

test("verification window is exactly ±1 step", () => {
  const nowMs = 1_111_111_109_000; // step 37037036
  const current = totpStep(nowMs);
  for (const delta of [-1, 0, 1]) {
    const code = hotp(RFC_KEY, current + delta);
    const match = verifyTotpCode(RFC_KEY_B32, code, { nowMs });
    assert.ok(match, `step ${delta} accepted`);
    assert.equal(match.step, current + delta);
  }
  for (const delta of [-2, 2]) {
    assert.equal(
      verifyTotpCode(RFC_KEY_B32, hotp(RFC_KEY, current + delta), { nowMs }),
      null,
      `step ${delta} rejected`,
    );
  }
  // Malformed codes never match.
  assert.equal(verifyTotpCode(RFC_KEY_B32, "12345", { nowMs }), null);
  assert.equal(verifyTotpCode(RFC_KEY_B32, "abcdef", { nowMs }), null);
});

test("lastUsedStep blocks replay of a code at or before the accepted step", () => {
  const nowMs = 2_000_000_000_000;
  const current = totpStep(nowMs);
  const code = hotp(RFC_KEY, current);
  const first = verifyTotpCode(RFC_KEY_B32, code, { nowMs });
  assert.ok(first);
  // Replaying the same code with its step recorded is rejected...
  assert.equal(
    verifyTotpCode(RFC_KEY_B32, code, { nowMs, lastUsedStep: first.step }),
    null,
  );
  // ...as is the previous window's code (step <= lastUsedStep)...
  assert.equal(
    verifyTotpCode(RFC_KEY_B32, hotp(RFC_KEY, current - 1), {
      nowMs,
      lastUsedStep: first.step,
    }),
    null,
  );
  // ...but the NEXT step's code is fresh.
  const next = verifyTotpCode(RFC_KEY_B32, hotp(RFC_KEY, current + 1), {
    nowMs,
    lastUsedStep: first.step,
  });
  assert.ok(next);
  assert.equal(next.step, first.step + 1);
});

test("generated secrets are 20 bytes of base32; the otpauth URI carries the app's identity", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/, "20 bytes → 32 base32 chars, no padding");
  assert.equal(base32Decode(secret).length, 20);
  const uri = buildOtpauthUri("ada@firm.ng", secret);
  assert.ok(uri.startsWith("otpauth://totp/MeridianIQ%3Aada%40firm.ng?"));
  assert.ok(uri.includes(`secret=${secret}`));
  assert.ok(uri.includes("issuer=MeridianIQ"));
  assert.ok(uri.includes(`period=${TOTP_STEP_SECONDS}`));
});

test("recovery codes: 8 readable codes, sha256-hashed, punctuation-insensitive", () => {
  const { codes, hashes } = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(hashes.length, RECOVERY_CODE_COUNT);
  for (const [i, code] of codes.entries()) {
    assert.equal(code.length, RECOVERY_CODE_LENGTH);
    assert.match(code, /^[A-Z2-9]+$/);
    assert.equal(hashRecoveryCode(code), hashes[i]);
    // A user typing it lowercase with separators still redeems.
    const sloppy = `${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`;
    assert.equal(hashRecoveryCode(sloppy), hashes[i]);
  }
  assert.equal(normalizeRecoveryCode("ab-cd ef"), "ABCDEF");
});

test("mfa pending token round-trips, expires, and honours its epoch", async () => {
  const userId = randomUUID();
  const now = Date.now();
  const token = await issueMfaToken(userId, 7, now);
  assert.deepEqual(await verifyMfaToken(token, now), { userId, epoch: 7 });
  // Still valid just inside the TTL; dead just past it.
  assert.ok(await verifyMfaToken(token, now + MFA_TOKEN_TTL_MS - 1_000));
  assert.equal(await verifyMfaToken(token, now + MFA_TOKEN_TTL_MS + 1_000), null);
  // Tampered signature is rejected.
  const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
  assert.equal(await verifyMfaToken(tampered, now), null);
});

test("session and mfa tokens are mutually unreadable despite the shared secret", async () => {
  const userId = randomUUID();
  const sessionToken = await issueSessionToken(userId, 3);
  const mfaToken = await issueMfaToken(userId, 3);
  // A session token presented at the challenge endpoint never verifies as an
  // mfa token (no colon-separated purposed payload)...
  assert.equal(await verifyMfaToken(sessionToken), null);
  // ...and an mfa token presented as a session cookie never parses as a
  // session (its decoded payload has no dot-separated fields).
  assert.equal(await verifySessionToken(mfaToken), null);
});
