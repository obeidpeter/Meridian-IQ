import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { getDb, auditEventsTable } from "@workspace/db";
import auditRouter from "../../routes/audit.ts";
import {
  appendAudit,
  exportAuditBundle,
  verifyChain,
} from "./audit.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { crossTenantPrincipal } from "../../test-helpers/principals.ts";

// Bounded reads (R98): the ledger is verified and exported in windows. These
// pin the window contract — anchored on the event before the window,
// `lastSeq`/`complete` say where the next window starts, a forged row is
// caught by the window that contains it, and a window that cannot be
// anchored is reported as broken, not as a 404.
//
// The ledger is append-only (an UPDATE is refused by the guardrails) and
// shared with every other suite — some of which insert forged rows of their
// own — so nothing here asserts that the WHOLE chain is valid; every
// assertion is a window over this run's own rows. The forged-row test runs
// last for the same reason: after it, the chain is broken from that row on.

const SALT = makeRunSalt();
const entity = `audit-window-${SALT}`;
const seqs: number[] = [];

before(async () => {
  for (let i = 0; i < 3; i++) {
    const row = await appendAudit({
      actorId: null,
      actorRole: "system",
      firmId: null,
      action: `test.window.${i}`,
      entityType: "test",
      entityId: entity,
      after: { i },
    });
    seqs.push(row.seq);
  }
});

after(async () => {
  await closeAllServers();
});

test("a window is anchored on the event before it and says where the next one starts", async () => {
  // A whole-ledger walk (batched server-side) always terminates with a shape
  // that says either "complete" or where it broke.
  const whole = await verifyChain();
  assert.equal(typeof whole.count, "number");
  assert.ok(whole.valid ? whole.complete : whole.brokenAtSeq !== null);

  const mine = await verifyChain({ afterSeq: seqs[0]! - 1, limit: 3 });
  assert.deepEqual(mine, {
    valid: true,
    count: 3,
    brokenAtSeq: null,
    lastSeq: seqs[2],
    complete: true,
  });

  const one = await verifyChain({ afterSeq: seqs[0], limit: 1 });
  assert.deepEqual(one, {
    valid: true,
    count: 1,
    brokenAtSeq: null,
    lastSeq: seqs[1],
    complete: false,
  });

  // No limit: from the anchor to the end of the ledger.
  const rest = await verifyChain({ afterSeq: seqs[1] });
  assert.deepEqual(rest, {
    valid: true,
    count: 1,
    brokenAtSeq: null,
    lastSeq: seqs[2],
    complete: true,
  });

  // Nothing after the very last event: an empty, complete window.
  assert.deepEqual(await verifyChain({ afterSeq: seqs[2] }), {
    valid: true,
    count: 0,
    brokenAtSeq: null,
    lastSeq: null,
    complete: true,
  });
});

test("the export bundle is one window with the verification of exactly those rows", async () => {
  const bundle = await exportAuditBundle({ afterSeq: seqs[0], limit: 2 });
  assert.deepEqual(
    bundle.events.map((e) => e.seq),
    [seqs[1], seqs[2]],
  );
  assert.equal(bundle.lastSeq, seqs[2]);
  assert.equal(bundle.complete, true);
  assert.deepEqual(bundle.verification, {
    valid: true,
    count: 2,
    brokenAtSeq: null,
    lastSeq: seqs[2],
    complete: true,
  });
  const firstPage = await exportAuditBundle({ afterSeq: seqs[0], limit: 1 });
  assert.deepEqual(firstPage.events.map((e) => e.seq), [seqs[1]]);
  assert.equal(firstPage.complete, false);
  assert.equal(firstPage.verification.complete, false);
});

test("routes: verify and export take a window; the CSV ledger reports its cursor", async () => {
  const base = await listen(appFor(crossTenantPrincipal("operator"), auditRouter as express.Router));

  const verify = (await (
    await fetch(`${base}/audit/verify?afterSeq=${seqs[0]}&limit=1`)
  ).json()) as Record<string, unknown>;
  assert.deepEqual(verify, { valid: true, count: 1, brokenAtSeq: null, lastSeq: seqs[1], complete: false });

  const exported = (await (
    await fetch(`${base}/audit/export?afterSeq=${seqs[0]}&limit=1`)
  ).json()) as { events: { seq: number }[]; lastSeq: number | null; complete: boolean };
  assert.deepEqual(exported.events.map((e) => e.seq), [seqs[1]]);
  assert.equal(exported.lastSeq, seqs[1]);
  assert.equal(exported.complete, false);

  const csv = await fetch(`${base}/audit/export/csv?afterSeq=${seqs[0]}`);
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get("x-audit-chain-valid"), "true");
  assert.equal(csv.headers.get("x-audit-export-complete"), "true");
  assert.equal(csv.headers.get("x-audit-last-seq"), String(seqs[2]));
  const body = await csv.text();
  assert.ok(body.startsWith("seq,created_at,"));
  assert.ok(body.includes(`,${entity},`), "the window's rows are in the file");

  assert.equal((await fetch(`${base}/audit/verify?limit=0`)).status, 400);
  assert.equal((await fetch(`${base}/audit/export?limit=5001`)).status, 400);
});

test("a forged row breaks the window that contains it; a missing anchor is a broken chain", async () => {
  const [forged] = await getDb()
    .insert(auditEventsTable)
    .values({
      action: "test.window.forged",
      entityType: "test",
      entityId: entity,
      hash: `forged-${SALT}`,
      prevHash: `forged-${SALT}`,
    })
    .returning({ seq: auditEventsTable.seq });
  const seq = forged!.seq;

  const window = await verifyChain({ afterSeq: seqs[2], limit: 5 });
  assert.equal(window.valid, false);
  assert.equal(window.brokenAtSeq, seq);
  assert.equal(window.count, 0, "nothing before the break in this window");
  assert.equal(window.complete, false);

  // The window anchored ON the forged row chains from its stored hash, so
  // what was appended after it still verifies — a break never hides later
  // tampering.
  const later = await appendAudit({
    action: "test.window.after-forge",
    entityType: "test",
    entityId: entity,
  });
  const afterForge = await verifyChain({ afterSeq: seq, limit: 1 });
  assert.deepEqual(afterForge, {
    valid: true,
    count: 1,
    brokenAtSeq: null,
    lastSeq: later.seq,
    complete: true,
  });

  const unanchored = await verifyChain({ afterSeq: 2_000_000_000 });
  assert.equal(unanchored.valid, false);
  assert.equal(unanchored.brokenAtSeq, 2_000_000_000);
});
