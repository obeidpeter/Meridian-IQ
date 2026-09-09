import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import {
  confirmationsTable,
  consentRecordsTable,
  creditDataRoomAccessEventsTable,
  eligibilityAssessmentsTable,
  engagementsTable,
  firmsTable,
  getDb,
  invoicesTable,
  membershipsTable,
  partiesTable,
  settlementEventsTable,
  stampRecordsTable,
  usersTable,
} from "@workspace/db";
import creditRouter from "../../routes/credit.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";
import { makeFlagGuard } from "../../test-helpers/flags.ts";
import {
  appFor,
  closeAllServers,
  JSON_HEADERS,
  listen,
} from "../../test-helpers/route-harness.ts";
import {
  crossTenantPrincipal,
  firmPrincipal,
} from "../../test-helpers/principals.ts";
import {
  CREDIT_POLICY,
  evaluateEligibility,
  type EligibilityFacts,
} from "./engine.ts";

const SALT = makeRunSalt();
const firmId = randomUUID();
const bankPartyId = randomUUID();
const bankUserId = randomUUID();
const ungrantedBankUserId = randomUUID();
const supplierIds = Array.from({ length: 5 }, () => randomUUID());
const buyerId = randomUUID();
const alternateBuyerId = randomUUID();
const invoiceIds = Array.from({ length: 5 }, () => randomUUID());
const operator = crossTenantPrincipal("operator");
const bankUser = crossTenantPrincipal("bank_user", { userId: bankUserId });
const ungrantedBankUser = crossTenantPrincipal("bank_user", {
  userId: ungrantedBankUserId,
});
const ordinaryFirmUser = firmPrincipal(firmId);
const creditFlag = makeFlagGuard("credit_readiness");
const dataRoomFlag = makeFlagGuard("bank_data_room");

let operatorBase = "";
let bankBase = "";
let ungrantedBankBase = "";
let firmBase = "";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const eligibleFacts: EligibilityFacts = {
  invoiceActive: true,
  amountConvertible: true,
  stampVerified: true,
  liveRailProvenance: true,
  buyerConfirmed: true,
  noSetOffConfirmed: true,
  settlementObserved: true,
  settlementSource: "collection_account",
  kybVerified: true,
  invoiceAmountNgn: 1_000_000,
  supplierOutstandingNgn: 0,
  priorHistoryInvoices: 6,
  buyerConcentrationBps: 4_286,
  buyerPriorObservations: 2,
  relatedPartySignal: false,
  reverseTradeCount: 0,
  volumeVsPriorAverageBps: 10_000,
};

// R108: the Data Room aggregates every consenting business on the platform,
// so this suite's k-anonymity assertions (suppressed below five businesses,
// exactly five once the fifth assessment lands) need an EMPTY population to
// start from, and assessments left by an earlier run on a reused scratch
// database would raise it past k. The assessment ledger is append-only
// (meridian_append_only), so the stale population is retired the way the
// product retires a business: one layer-3 revoke per stale supplier, which
// the Data Room's latest-consent join honours immediately. The api-server
// suite already runs only against a database declared disposable
// (E2E_DATABASE_DISPOSABLE=1 in the verify battery and in CI); without the
// flag the suite fails fast with the reason instead of a misleading
// k-anonymity assertion.
async function retireStaleAssessmentPopulation(): Promise<void> {
  const stale = await getDb()
    .selectDistinct({ partyId: eligibilityAssessmentsTable.supplierPartyId })
    .from(eligibilityAssessmentsTable)
    .where(isNotNull(eligibilityAssessmentsTable.supplierPartyId));
  if (stale.length === 0) return;
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "credit.integration needs an empty assessment population: set E2E_DATABASE_DISPOSABLE=1 to retire (layer-3 revoke) the businesses an earlier run left on this scratch database",
  );
  await getDb()
    .insert(consentRecordsTable)
    .values(
      stale.map(({ partyId }) => ({
        partyId: partyId as string,
        layer: 3,
        action: "revoke" as const,
        scope: "credit_scoring",
        basis: "consent",
        channel: "test",
      })),
    );
}

before(async () => {
  await creditFlag.saveAndSet(true);
  await dataRoomFlag.saveAndSet(true);
  await retireStaleAssessmentPopulation();
  const db = getDb();
  await db.insert(firmsTable).values({
    id: firmId,
    name: `Credit Firm ${SALT}`,
  });
  await db.insert(partiesTable).values([
    ...supplierIds.map((id, index) => ({
      id,
      type: "client_business" as const,
      legalName: `Protected Business ${index} ${SALT}`,
      tin: `9000000${index}-${SALT.slice(-4)}`,
    })),
    { id: buyerId, type: "buyer", legalName: `Buyer A ${SALT}` },
    { id: alternateBuyerId, type: "buyer", legalName: `Buyer B ${SALT}` },
    { id: bankPartyId, type: "bank", legalName: `Bank ${SALT}` },
  ]);
  await db.insert(engagementsTable).values(
    supplierIds.map((clientPartyId, index) => ({
      firmId,
      clientPartyId,
      type: "retainer" as const,
      status: "in_progress" as const,
      title: `Credit readiness ${index}`,
    })),
  );
  await db.insert(usersTable).values([
    {
      id: bankUserId,
      email: `bank-${SALT}@test.local`,
      fullName: "Bank Reviewer",
      totpEnabledAt: new Date(),
    },
    {
      id: ungrantedBankUserId,
      email: `bank-ungranted-${SALT}@test.local`,
      fullName: "Ungoverned Reviewer",
      totpEnabledAt: new Date(),
    },
  ]);
  await db.insert(membershipsTable).values([
    { userId: bankUserId, role: "bank_user" },
    { userId: ungrantedBankUserId, role: "bank_user" },
  ]);
  await db.insert(consentRecordsTable).values(
    supplierIds.map((partyId) => ({
      partyId,
      layer: 3,
      action: "grant" as const,
      scope: "credit_scoring",
      basis: "consent",
      channel: "test",
    })),
  );
  await db.insert(invoicesTable).values(
    invoiceIds.map((id, index) => ({
      id,
      firmId,
      supplierPartyId: supplierIds[index],
      buyerPartyId: buyerId,
      invoiceNumber: `CR-${index}-${SALT}`,
      issueDate: daysAgo(index + 1),
      status: "settled" as const,
      grandTotal: "1000000.00",
    })),
  );

  // Six prior settled invoices make the first supplier's assessment neither a
  // thin file nor concentrated on one buyer (two of six use the current buyer).
  await db.insert(invoicesTable).values(
    Array.from({ length: 6 }, (_, index) => ({
      firmId,
      supplierPartyId: supplierIds[0],
      buyerPartyId: index < 2 ? buyerId : alternateBuyerId,
      invoiceNumber: `CR-H-${index}-${SALT}`,
      issueDate: daysAgo(30 + index),
      status: "settled" as const,
      grandTotal: "1000000.00",
    })),
  );
  await db.insert(stampRecordsTable).values({
    invoiceId: invoiceIds[0],
    irn: `IRN-${SALT}`,
    csid: `CSID-${SALT}`,
    qrPayload: `QR-${SALT}`,
    signedArtifactRef: `artifact:${SALT}`,
    rail: "rail_primary",
    provider: "integration-test",
    environment: "live",
  });
  await db.insert(confirmationsTable).values({
    invoiceId: invoiceIds[0],
    buyerPartyId: buyerId,
    state: "confirmed",
    method: "buyer_portal",
    noSetOff: true,
  });
  await db.insert(settlementEventsTable).values({
    invoiceId: invoiceIds[0],
    source: "collection_account",
    amount: "1000000.00",
    paymentStatus: "paid",
    externalReference: `CR-PAY-${SALT}`,
    occurredAt: new Date(),
  });

  [operatorBase, bankBase, ungrantedBankBase, firmBase] = await Promise.all([
    listen(appFor(operator, creditRouter)),
    listen(appFor(bankUser, creditRouter)),
    listen(appFor(ungrantedBankUser, creditRouter)),
    listen(appFor(ordinaryFirmUser, creditRouter)),
  ]);
});

after(async () => {
  await closeAllServers();
  await dataRoomFlag.restore();
  await creditFlag.restore();
});

test("bank endpoints reject unrelated and ungoverned identities", async () => {
  assert.equal((await fetch(`${firmBase}/credit/data-room`)).status, 403);
  assert.equal(
    (await fetch(`${ungrantedBankBase}/credit/data-room`)).status,
    403,
  );
});

test("operator evidence produces one deterministic assessment across concurrent retries", async () => {
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(
    Date.now() + 365 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const kyb = await fetch(`${operatorBase}/operator/credit/kyb-checks`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      firmId,
      partyId: supplierIds[0],
      idempotencyKey: randomUUID(),
      beneficialOwnerCount: 1,
      ownershipCoverageBps: 10_000,
      beneficialOwnersVerified: true,
      bankAccountOwnership: "verified",
      sanctionsScreening: "verified",
      pepScreening: "verified",
      adverseMediaScreening: "verified",
      provider: "verified-provider",
      providerReference: `kyb:${SALT}`,
      evidenceRefs: [`vault:kyb/${SALT}`],
      checkedAt,
      expiresAt,
    }),
  });
  assert.equal(kyb.status, 201);
  assert.equal(((await kyb.json()) as { status: string }).status, "verified");

  const idempotencyKey = randomUUID();
  const request = () =>
    fetch(`${operatorBase}/operator/credit/assessments/run`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ invoiceId: invoiceIds[0], idempotencyKey }),
    });
  const responses = await Promise.all([request(), request()]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [201, 201],
  );
  const rows = (await Promise.all(
    responses.map((response) => response.json()),
  )) as {
    id: string;
    decision: string;
    score: number;
    rules: { key: string; outcome: string }[];
  }[];
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(rows[0].decision, "eligible");
  assert.equal(rows[0].score, 100);
  assert.equal(
    rows[0].rules.find((rule) => rule.key === "no_set_off_confirmed")?.outcome,
    "pass",
  );
  const stored = await getDb()
    .select()
    .from(eligibilityAssessmentsTable)
    .where(eq(eligibilityAssessmentsTable.invoiceId, invoiceIds[0]));
  assert.equal(stored.length, 1);
});

test("the data room suppresses small populations, opens at k=5 and records access", async () => {
  const grant = await fetch(`${operatorBase}/operator/credit/bank-access`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      bankPartyId,
      userId: bankUserId,
      action: "grant",
      dpaReference: `DPA-${SALT}`,
      dpaExecutedAt: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      reason: "Approved integration-test access",
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(grant.status, 201);

  const result = evaluateEligibility(eligibleFacts, CREDIT_POLICY);
  const directRows = [1, 2, 3, 4].map((index) => ({
    invoiceId: invoiceIds[index],
    firmId,
    supplierPartyId: supplierIds[index],
    buyerPartyId: buyerId,
    decision: result.decision,
    eligible: "true",
    score: result.score,
    scorecardVersion: CREDIT_POLICY.scorecardVersion,
    rulesetVersion: CREDIT_POLICY.rulesetVersion,
    features: result.features,
    ruleResults: result.rules,
    reasons: result.reasons,
    sourceSnapshot: { facts: eligibleFacts, evidence: {} },
    policySnapshot: CREDIT_POLICY as unknown as Record<string, unknown>,
    inputHash: hash(`assessment-${index}-${SALT}`),
    idempotencyKey: randomUUID(),
    requestedByUserId: operator.userId,
  }));
  await getDb()
    .insert(eligibilityAssessmentsTable)
    .values(directRows.slice(0, 3));

  const suppressedResponse = await fetch(`${bankBase}/credit/data-room`);
  assert.equal(suppressedResponse.status, 200);
  assert.match(
    suppressedResponse.headers.get("cache-control") ?? "",
    /no-store/,
  );
  const suppressed = (await suppressedResponse.json()) as {
    available: boolean;
    metrics: unknown;
    cohorts: unknown[];
    privacy: { minimumCohortSize: number; directIdentifiersShared: boolean };
  };
  assert.equal(suppressed.available, false);
  assert.equal(suppressed.metrics, null);
  assert.deepEqual(suppressed.cohorts, []);
  assert.equal(suppressed.privacy.minimumCohortSize, 5);

  await getDb().insert(eligibilityAssessmentsTable).values(directRows[3]);
  const availableResponse = await fetch(`${bankBase}/credit/data-room`);
  assert.equal(availableResponse.status, 200);
  const available = (await availableResponse.json()) as {
    available: boolean;
    metrics: { consentingBusinesses: number } | null;
    cohorts: { businesses: number }[];
    privacy: {
      directIdentifiersShared: boolean;
      exactAmountsShared: boolean;
      rawExportsEnabled: boolean;
    };
  };
  assert.equal(available.available, true);
  assert.equal(available.metrics?.consentingBusinesses, 5);
  assert.equal(available.cohorts.length, 1);
  assert.equal(available.cohorts[0].businesses, 5);
  assert.equal(available.privacy.directIdentifiersShared, false);
  assert.equal(available.privacy.exactAmountsShared, false);
  assert.equal(available.privacy.rawExportsEnabled, false);
  const serialized = JSON.stringify(available);
  for (const protectedValue of [
    ...supplierIds,
    `Protected Business 0 ${SALT}`,
  ]) {
    assert.equal(serialized.includes(protectedValue), false);
  }

  const accessLog = await fetch(
    `${bankBase}/credit/data-room/access-log?limit=10`,
  );
  assert.equal(accessLog.status, 200);
  const accessRows = (await accessLog.json()) as unknown[];
  assert.equal(accessRows.length, 2);
  const storedAccess = await getDb()
    .select()
    .from(creditDataRoomAccessEventsTable)
    .where(eq(creditDataRoomAccessEventsTable.bankPartyId, bankPartyId));
  assert.equal(storedAccess.length, 3);
});

test("the latest revoke immediately closes the data room", async () => {
  const revoke = await fetch(`${operatorBase}/operator/credit/bank-access`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      bankPartyId,
      userId: bankUserId,
      action: "revoke",
      reason: "Integration-test access ended",
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(revoke.status, 201);
  assert.equal((await fetch(`${bankBase}/credit/data-room`)).status, 403);
});
