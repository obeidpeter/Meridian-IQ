import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../errors.ts";
import {
  decryptRoomToken,
  digestRoomSecret,
  encryptRoomToken,
  invoiceRoomSecurityConfiguration,
  invoiceRoomLink,
  makeRoomSecret,
  maskEmail,
  maskPhone,
  roomOtpDigest,
  safeDigestEqual,
} from "./security.ts";

const ORIGINAL = {
  nodeEnv: process.env.NODE_ENV,
  key: process.env.INVOICE_ROOM_ENCRYPTION_KEY,
  publicUrl: process.env.PUBLIC_APP_URL,
};

function restoreEnv() {
  if (ORIGINAL.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL.nodeEnv;
  if (ORIGINAL.key === undefined)
    delete process.env.INVOICE_ROOM_ENCRYPTION_KEY;
  else process.env.INVOICE_ROOM_ENCRYPTION_KEY = ORIGINAL.key;
  if (ORIGINAL.publicUrl === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = ORIGINAL.publicUrl;
}

test("room secrets are URL-safe, random, and stored as deterministic digests", () => {
  const first = makeRoomSecret();
  const second = makeRoomSecret();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(digestRoomSecret(first), digestRoomSecret(first));
  assert.notEqual(digestRoomSecret(first), first);
  assert.equal(
    safeDigestEqual(digestRoomSecret(first), digestRoomSecret(first)),
    true,
  );
  assert.equal(
    safeDigestEqual(digestRoomSecret(first), digestRoomSecret(second)),
    false,
  );
});

test("OTP digests are bound to both the room session and code", () => {
  const session = makeRoomSecret();
  const digest = roomOtpDigest(session, "123456");
  assert.notEqual(digest, roomOtpDigest(session, "123457"));
  assert.notEqual(digest, roomOtpDigest(makeRoomSecret(), "123456"));
});

test("AES-GCM room credentials round-trip and reject ciphertext tampering", () => {
  process.env.NODE_ENV = "test";
  process.env.INVOICE_ROOM_ENCRYPTION_KEY = "11".repeat(32);
  try {
    const secret = makeRoomSecret();
    const first = encryptRoomToken(secret);
    const second = encryptRoomToken(secret);
    assert.notEqual(
      first,
      second,
      "a fresh GCM IV is used for every encryption",
    );
    assert.equal(decryptRoomToken(first), secret);
    const parts = first.split(".");
    parts[1] = `${parts[1]?.startsWith("A") ? "B" : "A"}${parts[1]?.slice(1)}`;
    const tampered = parts.join(".");
    assert.throws(
      () => decryptRoomToken(tampered),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "INVOICE_ROOM_CREDENTIAL",
    );
  } finally {
    restoreEnv();
  }
});

test("production fails closed without a dedicated 256-bit encryption key", () => {
  process.env.NODE_ENV = "production";
  delete process.env.INVOICE_ROOM_ENCRYPTION_KEY;
  try {
    assert.throws(
      () => encryptRoomToken("secret"),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "INVOICE_ROOM_CONFIGURATION" &&
        error.status === 503,
    );
    process.env.INVOICE_ROOM_ENCRYPTION_KEY = "too-short";
    assert.throws(
      () => encryptRoomToken("secret"),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "INVOICE_ROOM_CONFIGURATION",
    );
  } finally {
    restoreEnv();
  }
});

test("share links keep the credential in the fragment, never the request URL", () => {
  process.env.NODE_ENV = "production";
  process.env.PUBLIC_APP_URL = "https://app.meridian.example/base";
  const token = makeRoomSecret();
  try {
    const link = new URL(invoiceRoomLink(token));
    assert.equal(link.origin, "https://app.meridian.example");
    assert.equal(link.pathname, "/invoice-room");
    assert.equal(link.search, "");
    assert.equal(new URLSearchParams(link.hash.slice(1)).get("token"), token);
  } finally {
    restoreEnv();
  }
});

test("production share links fail closed without an explicit safe public URL", () => {
  process.env.NODE_ENV = "production";
  const token = makeRoomSecret();
  try {
    delete process.env.PUBLIC_APP_URL;
    assert.throws(
      () => invoiceRoomLink(token),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "INVOICE_ROOM_CONFIGURATION" &&
        error.status === 503,
    );
    process.env.PUBLIC_APP_URL = "http://app.meridian.example";
    assert.equal(invoiceRoomSecurityConfiguration().publicUrlConfigured, false);
    process.env.PUBLIC_APP_URL = "https://user:pass@app.meridian.example";
    assert.equal(invoiceRoomSecurityConfiguration().publicUrlConfigured, false);
  } finally {
    restoreEnv();
  }
});

test("contact masks retain routing context without returning the full address", () => {
  assert.equal(maskEmail("accounts@example.com"), "ac••••••@example.com");
  assert.equal(maskPhone("+2348012345678"), "+234 •••• 678");
  assert.equal(maskEmail(null), null);
  assert.equal(maskPhone(null), null);
});
