import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  submissionAttemptsTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import { draftCatalogueEntryWithClerk } from "./draft-catalogue.ts";
import { computeCalibration } from "./metrics.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Catalogue drafting assistant: the draft is grounded in observed rail
// rejections, fenced as untrusted data, and RETURNED (never saved) — plus the
// pure calibration fold that joins extraction confidence with the corrections
// exhaust. Fail-closed behaviours are pinned like every other Clerk surface.

const SALT = makeRunSalt();
const CODE = `TEST_UNMAPPED_${SALT.toUpperCase()}`;

const firmId = randomUUID();
const partyId = randomUUID();
const invoiceId = randomUUID();

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Catalogue Firm ${SALT}` });
  await db.insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: `Catalogue Party ${SALT}`,
  });
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: partyId,
    buyerPartyId: partyId,
    invoiceNumber: `CAT-${SALT}`,
    issueDate: "2026-07-01",
  });
  await db.insert(submissionAttemptsTable).values(
    [1, 2].map((n) => ({
      invoiceId,
      rail: "rail_primary" as const,
      attemptNo: n,
      idempotencyKey: `cat-${SALT}-${n}`,
      status: "rejected" as const,
      errorCode: CODE,
      responsePayload: {
        code: CODE,
        detail: `TIN checksum failed for supplier (sample ${n})`,
      },
    })),
  );
});

after(async () => {
  await restoreClerkFlag();
});

test("drafts a catalogue entry grounded in the observed rejections", async () => {
  let seenUser = "";
  const gateway = fakeGateway((req) => {
    seenUser = typeof req.user === "string" ? req.user : "";
    return JSON.stringify({
      cause: "The tax authority rejected the supplier's TIN.",
      fix: "Verify the TIN and re-submit the invoice.",
      retriable: false,
    });
  });
  const draft = await draftCatalogueEntryWithClerk(CODE, gateway);
  assert.equal(draft.code, CODE);
  assert.equal(draft.sampleCount, 2, "both observed rejections ground the draft");
  assert.equal(draft.retriable, false);
  assert.match(draft.cause, /TIN/);
  // The raw payloads travel to the model fenced as untrusted data.
  assert.match(seenUser, /TIN checksum failed/);
  assert.match(seenUser, /UNTRUSTED|REJECTIONS/i);
});

test("fails closed on invalid model output — never a half-guessed entry", async () => {
  const gateway = fakeGateway(() => "not json at all");
  await assert.rejects(
    draftCatalogueEntryWithClerk(CODE, gateway),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "CLERK_DRAFT_FAILED");
      assert.equal(err.status, 502);
      return true;
    },
  );
});

test("a code never observed on any attempt is a 404, not an ungrounded draft", async () => {
  let providerCalls = 0;
  const gateway = fakeGateway(() => {
    providerCalls += 1;
    return "{}";
  });
  await assert.rejects(
    draftCatalogueEntryWithClerk(`NEVER_SEEN_${SALT.toUpperCase()}`, gateway),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "CODE_NOT_OBSERVED");
      return true;
    },
  );
  assert.equal(providerCalls, 0, "no grounding, no model call");
});

test("computeCalibration folds confidence bands against the corrections exhaust", () => {
  const field = (name: string, confidence: number) => ({
    field: name,
    value: "x",
    confidence,
    sourceSnippet: null,
    critical: false,
    flagged: false,
  });
  const kase = (
    fields: ReturnType<typeof field>[],
    changed: Record<string, boolean>,
  ) => ({
    extraction: {
      fields,
      lines: [],
      promptVersion: "t",
      model: "t",
    } as never,
    corrections: Object.entries(changed).map(([f, c]) => ({
      field: f,
      extracted: "a",
      final: c ? "b" : "a",
      changed: c,
    })),
  });

  const result = computeCalibration([
    // High-confidence field kept; low-confidence field overridden — the
    // calibrated pattern.
    kase(
      [field("invoiceNumber", 0.95), field("issueDate", 0.3)],
      { invoiceNumber: false, issueDate: true },
    ),
    // High-confidence field overridden: drags the top band's keptRate down.
    kase([field("invoiceNumber", 0.9)], { invoiceNumber: true }),
    // Line corrections are excluded from calibration.
    kase([field("subtotal", 0.85)], { "lines.count": true, subtotal: false }),
  ]);

  assert.ok(result, "corrected approvals produce a calibration");
  assert.equal(result.sampleFields, 4);
  const top = result.buckets.find((b) => b.range === "0.8-1.0")!;
  assert.equal(top.fields, 3);
  assert.equal(top.keptRate, Number((2 / 3).toFixed(4)));
  const low = result.buckets.find((b) => b.range === "0.0-0.5")!;
  assert.equal(low.fields, 1);
  assert.equal(low.keptRate, 0);

  assert.equal(
    computeCalibration([{ extraction: null, corrections: null }]),
    undefined,
    "no corrected approvals, no calibration section",
  );
});
