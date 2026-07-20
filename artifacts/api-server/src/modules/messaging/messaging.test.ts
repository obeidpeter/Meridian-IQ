import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import {
  relayConfigured,
  sendMessage,
  sendRawToRelay,
  setMessageTransport,
  resetMessageTransport,
} from "./messaging.ts";
import { listen, closeAllServers } from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// The message transport seam. Pinned invariants:
//  - with no MESSAGING_WEBHOOK_URL configured the default transport is the
//    in-process simulator — today's behaviour exactly (dark by default);
//  - an injected transport that fails (or throws) drives the existing
//    failover walk, and all-channels-failed still lands the historical
//    "failed" row;
//  - the webhook transport POSTs the POINTER-ONLY payload {channel,
//    recipientRef, templateKey, entityRef} with x-op-token, and a non-2xx
//    reply counts as a channel failure.

const SALT = makeRunSalt();

// recipientRef/entityId must survive assertPointerOnly: letters only.
const makeRef = () => `ref-${randomUUID().replace(/[^a-z]/gi, "")}`;

const savedUrl = process.env.MESSAGING_WEBHOOK_URL;
const savedToken = process.env.MESSAGING_WEBHOOK_TOKEN;

function restoreEnv() {
  if (savedUrl === undefined) delete process.env.MESSAGING_WEBHOOK_URL;
  else process.env.MESSAGING_WEBHOOK_URL = savedUrl;
  if (savedToken === undefined) delete process.env.MESSAGING_WEBHOOK_TOKEN;
  else process.env.MESSAGING_WEBHOOK_TOKEN = savedToken;
}

after(async () => {
  restoreEnv();
  resetMessageTransport();
  await closeAllServers();
});

test("no webhook env: the default transport simulates and the send succeeds", async () => {
  delete process.env.MESSAGING_WEBHOOK_URL;
  delete process.env.MESSAGING_WEBHOOK_TOKEN;
  resetMessageTransport();
  const row = await sendMessage({
    channel: "whatsapp",
    recipientRef: makeRef(),
    templateKey: "deadline_reminder",
    entityType: "invoice",
    entityId: "inv-abc",
  });
  assert.equal(row.status, "sent");
  assert.equal(row.channel, "whatsapp");
  assert.equal(row.failoverFrom, null);
  assert.match(row.providerMessageId ?? "", /^prov_whatsapp_/);
});

test("the ledger row carries the caller's recipient identity — sent AND failed rows", async () => {
  // The identity columns are what the notification inbox scopes by
  // (inbox.ts); the lossy ref is display/correlation only. Both terminal row
  // shapes must carry them, or a failed send would vanish from the feed.
  const partyId = randomUUID();
  setMessageTransport(async () => ({ ok: true, providerMessageId: `ok_${SALT}` }));
  try {
    const sent = await sendMessage({
      channel: "whatsapp",
      recipientRef: makeRef(),
      recipientPartyId: partyId,
      templateKey: "deadline_reminder",
    });
    assert.equal(sent.recipientPartyId, partyId);
    assert.equal(sent.recipientUserId, null);

    setMessageTransport(async () => ({ ok: false, error: "down" }));
    const userId = randomUUID();
    const failed = await sendMessage({
      channel: "email",
      recipientRef: makeRef(),
      recipientUserId: userId,
      templateKey: "firm_digest_ready",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.recipientUserId, userId);
    assert.equal(failed.recipientPartyId, null);
  } finally {
    resetMessageTransport();
  }
});

test("a failing transport drives the failover walk", async () => {
  setMessageTransport(async (channel) =>
    channel === "whatsapp"
      ? { ok: false, error: "provider down" }
      : { ok: true, providerMessageId: `inj_${SALT}` },
  );
  try {
    const row = await sendMessage({
      channel: "whatsapp",
      recipientRef: makeRef(),
      templateKey: "deadline_reminder",
      entityType: "invoice",
      entityId: "inv-abc",
    });
    assert.equal(row.status, "sent");
    assert.equal(row.channel, "sms", "fell over whatsapp → sms");
    assert.equal(row.failoverFrom, "whatsapp");
    assert.equal(row.providerMessageId, `inj_${SALT}`);
  } finally {
    resetMessageTransport();
  }
});

test("a throwing transport is a channel failure; all-fail lands the historical failed row", async () => {
  setMessageTransport(async () => {
    throw new Error("relay exploded");
  });
  try {
    const ref = makeRef();
    const row = await sendMessage({
      channel: "whatsapp",
      recipientRef: ref,
      templateKey: "deadline_reminder",
      entityType: "invoice",
      entityId: "inv-abc",
    });
    assert.equal(row.status, "failed");
    assert.equal(row.channel, "whatsapp", "row records the requested channel");
    assert.equal(row.error, "all channels failed");
    assert.equal(row.recipientRef, ref);
  } finally {
    resetMessageTransport();
  }
});

test("webhook transport: pointer-only POST with x-op-token; provider id flows into the row", async () => {
  const seen: Array<{ body: unknown; token: string | undefined }> = [];
  const relay = express();
  relay.use(express.json());
  relay.post("/hook", (req, res) => {
    seen.push({ body: req.body, token: req.get("x-op-token") });
    res.json({ providerMessageId: `wh_${SALT}` });
  });
  const base = await listen(relay);
  process.env.MESSAGING_WEBHOOK_URL = `${base}/hook`;
  process.env.MESSAGING_WEBHOOK_TOKEN = `hook-secret-${SALT}`;
  resetMessageTransport();
  try {
    const ref = makeRef();
    const row = await sendMessage({
      channel: "email",
      recipientRef: ref,
      templateKey: "invoice_stamped",
      entityType: "invoice",
      entityId: "inv-xyz",
    });
    assert.equal(row.status, "sent");
    assert.equal(row.providerMessageId, `wh_${SALT}`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].token, `hook-secret-${SALT}`);
    // The wire payload is POINTERS only — refs, never addresses or amounts.
    assert.deepEqual(seen[0].body, {
      channel: "email",
      recipientRef: ref,
      templateKey: "invoice_stamped",
      entityRef: "inv-xyz",
    });
  } finally {
    restoreEnv();
    resetMessageTransport();
  }
});

test("webhook non-2xx is a channel failure: the walk continues and all-fail records failed", async () => {
  const hits: string[] = [];
  const relay = express();
  relay.use(express.json());
  relay.post("/hook", (req, res) => {
    hits.push((req.body as { channel: string }).channel);
    res.status(500).json({ error: "relay down" });
  });
  const base = await listen(relay);
  process.env.MESSAGING_WEBHOOK_URL = `${base}/hook`;
  delete process.env.MESSAGING_WEBHOOK_TOKEN;
  resetMessageTransport();
  try {
    const row = await sendMessage({
      channel: "whatsapp",
      recipientRef: makeRef(),
      templateKey: "deadline_reminder",
      entityType: "invoice",
      entityId: "inv-abc",
    });
    assert.equal(row.status, "failed");
    assert.equal(row.error, "all channels failed");
    // The walk tried every permitted channel through the webhook.
    assert.deepEqual(hits, ["whatsapp", "sms", "email"]);

    // Unsetting the URL restores the simulator (dark by default).
    delete process.env.MESSAGING_WEBHOOK_URL;
    const again = await sendMessage({
      channel: "whatsapp",
      recipientRef: makeRef(),
      templateKey: "deadline_reminder",
      entityType: "invoice",
      entityId: "inv-abc",
    });
    assert.equal(again.status, "sent");
    assert.match(again.providerMessageId ?? "", /^prov_whatsapp_/);
  } finally {
    restoreEnv();
    resetMessageTransport();
  }
});

test("sendRawToRelay: dark relay refuses locally; a live relay gets the kind-tagged payload with x-op-token", async () => {
  delete process.env.MESSAGING_WEBHOOK_URL;
  delete process.env.MESSAGING_WEBHOOK_TOKEN;
  assert.equal(relayConfigured(), false);
  const dark = await sendRawToRelay("staff_email_verify", { email: "x@y.z", code: "123456" });
  assert.equal(dark.ok, false, "no relay: nothing to send to");

  const seen: Array<{ body: unknown; token: string | undefined }> = [];
  const relay = express();
  relay.use(express.json());
  relay.post("/hook", (req, res) => {
    seen.push({ body: req.body, token: req.get("x-op-token") });
    res.json({});
  });
  const base = await listen(relay);
  process.env.MESSAGING_WEBHOOK_URL = `${base}/hook`;
  process.env.MESSAGING_WEBHOOK_TOKEN = `raw-secret-${SALT}`;
  try {
    assert.equal(relayConfigured(), true);
    const ok = await sendRawToRelay("staff_email_verify", {
      email: `raw-${SALT}@test.example`,
      code: "654321",
    });
    assert.equal(ok.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].token, `raw-secret-${SALT}`);
    // The kind tag rides first-class next to the payload fields (the shape
    // routes/staff.ts's verification dispatch relies on).
    assert.deepEqual(seen[0].body, {
      kind: "staff_email_verify",
      email: `raw-${SALT}@test.example`,
      code: "654321",
    });
  } finally {
    restoreEnv();
  }
});

test("sendRawToRelay: a non-2xx reply reports failure, never throws", async () => {
  const relay = express();
  relay.use(express.json());
  relay.post("/hook", (_req, res) => {
    res.status(500).json({ error: "relay down" });
  });
  const base = await listen(relay);
  process.env.MESSAGING_WEBHOOK_URL = `${base}/hook`;
  delete process.env.MESSAGING_WEBHOOK_TOKEN;
  try {
    const result = await sendRawToRelay("staff_email_verify", { email: "a@b.c", code: "1" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /500/);
  } finally {
    restoreEnv();
  }
});
