import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  confirmationsTable,
  consentRecordsTable,
  engagementsTable,
  featureFlagOverridesTable,
  featureFlagsTable,
  filingReturnsTable,
  firmsTable,
  firmPoliciesTable,
  getDb,
  invoiceLifecycleEventsTable,
  invoicesTable,
  invoiceApprovalsTable,
  stampRecordsTable,
  obligationsTable,
  partiesTable,
  usersTable,
  workItemsTable,
} from "@workspace/db";
import workspaceRouter from "../../routes/workspace.ts";
import type { Principal } from "../auth/rbac.ts";
import { setRailTransport } from "../rails/adapter.ts";
import {
  appFor,
  closeAllServers,
  listen,
} from "../../test-helpers/route-harness.ts";
import {
  buyerPrincipal,
  clientPrincipal,
  firmPrincipal,
} from "../../test-helpers/principals.ts";

type TodayResponse = {
  generatedAt: string;
  summary: { total: number; urgent: number; dueSoon: number; blocked: number };
  items: Array<{
    id: string;
    source: string;
    priority: string;
    status: string;
    dueAt: string | null;
    clientPartyId: string | null;
  }>;
  setup: Array<{
    id: string;
    complete: boolean;
    href: string;
    description: string;
    blockedReason?: string | null;
  }>;
};

after(closeAllServers);

function dateOffset(days: number): string {
  return new Date(Date.now() + days * 86400000 + 3600000)
    .toISOString()
    .slice(0, 10);
}

async function makeScope(statutory = true) {
  const db = getDb();
  const firmId = randomUUID();
  const userId = randomUUID();
  const siblingUserId = randomUUID();
  const clientId = randomUUID();
  const siblingId = randomUUID();
  const buyerId = randomUUID();
  const otherBuyerId = randomUUID();
  await db.insert(firmsTable).values({ id: firmId, name: `Today ${firmId}` });
  await db.insert(usersTable).values([
    { id: userId, email: `${userId}@today.test` },
    { id: siblingUserId, email: `${siblingUserId}@today.test` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: clientId,
      type: "client_business",
      legalName: "First client",
      tin: "12345678",
      street: "1 Test Street",
      city: "Lagos",
      countryCode: "NG",
      createdAt: new Date("2020-01-01T00:00:00Z"),
    },
    {
      id: siblingId,
      type: "client_business",
      legalName: "Sibling client",
      createdAt: new Date("2021-01-01T00:00:00Z"),
    },
    { id: buyerId, type: "buyer", legalName: "First buyer" },
    { id: otherBuyerId, type: "buyer", legalName: "Other buyer" },
  ]);
  await db.insert(engagementsTable).values([
    {
      firmId,
      clientPartyId: clientId,
      type: "readiness_assessment",
      title: "First",
    },
    {
      firmId,
      clientPartyId: siblingId,
      type: "readiness_assessment",
      title: "Sibling",
    },
  ]);
  for (const [key, enabled] of [
    ["invoice_lifecycle", true],
    ["statutory_desks", statutory],
    ["erp_connectors", false],
    ["reconciliation", false],
  ] as const) {
    await db
      .insert(featureFlagsTable)
      .values({ key, enabled: false, description: "Today fixture" })
      .onConflictDoNothing();
    await db
      .insert(featureFlagOverridesTable)
      .values({ firmId, flagKey: key, enabled });
  }
  return {
    firmId,
    userId,
    siblingUserId,
    clientId,
    siblingId,
    buyerId,
    otherBuyerId,
  };
}

async function invoice(
  scope: Awaited<ReturnType<typeof makeScope>>,
  overrides: Partial<typeof invoicesTable.$inferInsert> = {},
) {
  const id = randomUUID();
  await getDb()
    .insert(invoicesTable)
    .values({
      id,
      firmId: scope.firmId,
      supplierPartyId: scope.clientId,
      buyerPartyId: scope.buyerId,
      invoiceNumber: `TODAY-${id}`,
      issueDate: dateOffset(-10),
      ...overrides,
    });
  return overrides.id ?? id;
}

async function today(principal: Principal, limit = 2): Promise<TodayResponse> {
  const base = await listen(appFor(principal, workspaceRouter));
  const response = await fetch(`${base}/workspace/today?limit=${limit}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body as TodayResponse;
}

function step(body: TodayResponse, id: string) {
  const found = body.setup.find((item) => item.id === id);
  assert.ok(found, `missing setup step ${id}`);
  return found;
}

test("Today ranks before limiting and counts the full scoped population across sources", async () => {
  const scope = await makeScope();
  const other = await makeScope();
  const db = getDb();
  await db.insert(invoicesTable).values(
    Array.from({ length: 120 }, (_, index) => ({
      firmId: scope.firmId,
      supplierPartyId: scope.clientId,
      buyerPartyId: scope.buyerId,
      invoiceNumber: `TODAY-${scope.firmId}-${index}`,
      issueDate: dateOffset(-5),
      dueDate: dateOffset(2),
    })),
  );
  const oldFailure = await invoice(scope, {
    status: "failed",
    createdAt: new Date("2020-01-01"),
    updatedAt: new Date("2020-01-01"),
  });
  const recentlyOverdue = await invoice(scope, { dueDate: dateOffset(-1) });
  await invoice(scope, {
    supplierPartyId: scope.siblingId,
    buyerPartyId: scope.otherBuyerId,
    status: "failed",
  });
  await invoice(other, { status: "failed" });
  await db.insert(workItemsTable).values([
    {
      firmId: scope.firmId,
      clientPartyId: scope.clientId,
      createdBy: scope.userId,
      clientRequestId: randomUUID(),
      title: "Blocked urgent task",
      status: "blocked",
      priority: "urgent",
    },
    {
      firmId: scope.firmId,
      clientPartyId: scope.clientId,
      createdBy: scope.userId,
      clientRequestId: randomUUID(),
      title: "Due soon",
      priority: "high",
      dueAt: new Date(Date.now() + 86400000),
    },
    {
      firmId: scope.firmId,
      clientPartyId: scope.clientId,
      createdBy: scope.userId,
      clientRequestId: randomUUID(),
      title: "Done task",
      status: "done",
      priority: "urgent",
    },
  ]);
  await db.insert(filingReturnsTable).values([
    {
      firmId: scope.firmId,
      clientPartyId: scope.clientId,
      taxType: "vat",
      period: "2025-01",
      dueDate: dateOffset(-1),
    },
    {
      firmId: scope.firmId,
      clientPartyId: scope.clientId,
      taxType: "vat",
      period: "2025-02",
      dueDate: dateOffset(-2),
      status: "filed",
    },
  ]);
  await db.insert(obligationsTable).values([
    {
      firmId: scope.firmId,
      clientPartyId: scope.clientId,
      noticeType: "assessment",
      authority: "Test authority",
      responseDueDate: dateOffset(1),
      createdBy: scope.userId,
    },
    {
      firmId: scope.firmId,
      clientPartyId: scope.clientId,
      noticeType: "assessment",
      authority: "Test authority",
      responseDueDate: dateOffset(-3),
      createdBy: scope.userId,
      status: "closed",
    },
  ]);
  const principal = clientPrincipal(scope.firmId, scope.clientId, {
    userId: scope.userId,
  });
  const small = await today(principal, 4);
  assert.deepEqual(small.summary, {
    total: 126,
    urgent: 4,
    dueSoon: 122,
    blocked: 2,
    completedSetupSteps: small.setup.filter((item) => item.complete).length,
    totalSetupSteps: small.setup.length,
  });
  assert.equal(small.items.length, 4);
  assert.ok(
    small.items.some((item) => item.id === `invoice:${oldFailure}`),
    "old failed invoice survives 120 newer drafts",
  );
  assert.equal(
    small.items.find((item) => item.id === `invoice:${recentlyOverdue}`)
      ?.priority,
    "urgent",
    "yesterday's Lagos deadline is overdue by less than 24h",
  );
  assert.ok(small.items.every((item) => item.clientPartyId === scope.clientId));
  const large = await today(principal, 50);
  assert.deepEqual(
    large.summary,
    small.summary,
    "totals do not depend on the requested display limit",
  );
  assert.deepEqual(large.items.slice(0, 4), small.items);
  const staff = await today(
    firmPrincipal(scope.firmId, { userId: scope.userId, role: "firm_staff" }),
    1,
  );
  assert.equal(
    staff.summary.total,
    127,
    "firm sees sibling, not the other tenant",
  );
  assert.equal(staff.summary.blocked, 3);
  assert.equal(
    staff.setup.some((item) => item.id === "first_connection"),
    false,
  );
});

test("Today excludes dark statutory sources and optional setup even when records exist", async () => {
  const scope = await makeScope(false);
  await getDb()
    .insert(filingReturnsTable)
    .values({
      firmId: scope.firmId,
      clientPartyId: scope.clientId,
      taxType: "vat",
      period: "2025-01",
      dueDate: dateOffset(-1),
    });
  await getDb()
    .insert(obligationsTable)
    .values({
      firmId: scope.firmId,
      clientPartyId: scope.clientId,
      noticeType: "assessment",
      authority: "Test authority",
      responseDueDate: dateOffset(-1),
      createdBy: scope.userId,
    });
  const body = await today(
    clientPrincipal(scope.firmId, scope.clientId, { userId: scope.userId }),
  );
  assert.equal(body.summary.total, 0);
  assert.equal(body.summary.urgent, 0);
  assert.equal(body.items.length, 0);
  assert.equal(
    body.setup.some((item) =>
      ["first_statement", "first_connection", "invoice_submission"].includes(
        item.id,
      ),
    ),
    false,
  );
});

test("manual task ties use stable IDs consistently before and after the limit", async () => {
  const scope = await makeScope(false);
  const ids = Array.from({ length: 8 }, () => randomUUID()).sort();
  const due = new Date(Date.now() + 86400000);
  await getDb()
    .insert(workItemsTable)
    .values(
      ids.map((id, index) => ({
        id,
        firmId: scope.firmId,
        clientPartyId: scope.clientId,
        createdBy: scope.userId,
        clientRequestId: randomUUID(),
        title: `Reverse title ${8 - index}`,
        priority: "high" as const,
        dueAt: due,
        createdAt: new Date(
          `2020-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        ),
      })),
    );
  const principal = clientPrincipal(scope.firmId, scope.clientId, {
    userId: scope.userId,
  });
  const small = await today(principal, 2);
  const large = await today(principal, 8);
  assert.deepEqual(
    small.items.map((item) => item.id),
    ids.slice(0, 2),
  );
  assert.deepEqual(
    large.items.map((item) => item.id),
    ids,
  );
  assert.equal(small.summary.total, 8);
});

test("buyer totals, failed priority and confirmation proof are not truncated to visible rows", async () => {
  const scope = await makeScope(false);
  await getDb()
    .insert(invoicesTable)
    .values(
      Array.from({ length: 25 }, (_, index) => ({
        firmId: scope.firmId,
        supplierPartyId: scope.clientId,
        buyerPartyId: scope.buyerId,
        invoiceNumber: `BUYER-${scope.firmId}-${index}`,
        issueDate: dateOffset(-5),
        dueDate: dateOffset(10),
        status: "stamped" as const,
      })),
    );
  await invoice(scope, {
    status: "confirmed",
    dueDate: dateOffset(10),
    updatedAt: new Date("2020-01-01"),
  });
  const failure = await invoice(scope, {
    status: "failed",
    updatedAt: new Date("2020-01-01"),
  });
  await invoice(scope, { status: "failed", buyerPartyId: scope.otherBuyerId });
  const body = await today(
    buyerPrincipal(scope.buyerId, { userId: scope.userId }),
    1,
  );
  assert.equal(body.summary.total, 27);
  assert.equal(body.summary.urgent, 1);
  assert.equal(body.summary.blocked, 1);
  assert.equal(body.items[0].id, `invoice:${failure}`);
  assert.equal(
    step(body, "first_confirmation").complete,
    true,
    "older confirmed invoice is outside visible top 1",
  );
  assert.equal(step(body, "review_queue").complete, true);
});

test("buyer recorded responses remain setup proof after the invoice leaves Today's queue", async () => {
  const scope = await makeScope(false);
  const id = await invoice(scope, { status: "settled" });
  await getDb().insert(confirmationsTable).values({
    invoiceId: id,
    buyerPartyId: scope.buyerId,
    state: "queried",
    confirmingUserId: scope.userId,
  });
  const body = await today(
    buyerPrincipal(scope.buyerId, { userId: scope.userId }),
    1,
  );
  assert.equal(body.summary.total, 0);
  assert.equal(step(body, "first_confirmation").complete, true);
  const other = await today(
    buyerPrincipal(scope.otherBuyerId, { userId: scope.userId }),
    1,
  );
  assert.equal(step(other, "first_confirmation").complete, false);
  assert.equal(step(other, "review_queue").complete, false);
});

test("first-invoice setup uses one supplier/receivable and current validation, not a sibling's work or stale history", async () => {
  const scope = await makeScope(false);
  const db = getDb();
  const sibling = await invoice(scope, {
    supplierPartyId: scope.siblingId,
    buyerPartyId: scope.otherBuyerId,
    status: "validated",
  });
  await db.insert(invoiceLifecycleEventsTable).values({
    invoiceId: sibling,
    firmId: scope.firmId,
    fromStatus: "draft",
    toStatus: "validated",
  });
  await invoice(scope, {
    supplierPartyId: scope.siblingId,
    buyerPartyId: scope.clientId,
    status: "validated",
  });
  const principal = clientPrincipal(scope.firmId, scope.clientId, {
    userId: scope.userId,
  });
  let body = await today(principal);
  assert.equal(
    step(body, "first_invoice").complete,
    false,
    "a payable or sibling receivable cannot complete the supplier's journey",
  );
  assert.equal(step(body, "business_identity").href, "/business");
  assert.equal(step(body, "invoice_validation").complete, false);
  assert.equal(step(body, "invoice_evidence").complete, false);
  const staff = await today(
    firmPrincipal(scope.firmId, { userId: scope.userId, role: "firm_staff" }),
  );
  assert.equal(
    step(staff, "first_invoice").complete,
    false,
    "firm journey sticks to the first engaged supplier",
  );
  assert.equal(
    step(staff, "business_identity").href,
    `/clients/${scope.clientId}/business`,
  );
  assert.equal(step(staff, "invoice_evidence").complete, false);

  const id = await invoice(scope);
  body = await today(principal);
  assert.equal(step(body, "first_invoice").complete, true);
  assert.equal(step(body, "first_invoice").href, `/invoices/${id}`);
  assert.equal(step(body, "first_customer").complete, true);
  assert.equal(
    step(body, "invoice_validation").complete,
    false,
    "a draft is not validated",
  );
  assert.equal(
    step(body, "invoice_evidence").complete,
    false,
    "an unrelated invoice's history is not evidence",
  );
  await db
    .insert(invoiceLifecycleEventsTable)
    .values({ invoiceId: id, firmId: scope.firmId, toStatus: "draft" });
  body = await today(principal);
  assert.equal(
    step(body, "invoice_evidence").complete,
    true,
    "recorded draft history needs no live provider",
  );
  await db
    .update(invoicesTable)
    .set({ status: "validated" })
    .where(eq(invoicesTable.id, id));
  await db.insert(invoiceLifecycleEventsTable).values({
    invoiceId: id,
    firmId: scope.firmId,
    fromStatus: "draft",
    toStatus: "validated",
  });
  assert.equal(
    step(await today(principal), "invoice_validation").complete,
    true,
  );
  for (const status of ["draft", "failed"] as const) {
    await db
      .update(invoicesTable)
      .set({ status, contentRevision: 2 })
      .where(eq(invoicesTable.id, id));
    assert.equal(
      step(await today(principal), "invoice_validation").complete,
      false,
      `${status} content cannot reuse historical validation`,
    );
  }
});

test("customer capture proof respects owner, firm and merges before the first invoice", async () => {
  const scope = await makeScope(false);
  const other = await makeScope(false);
  const db = getDb();
  const principal = clientPrincipal(scope.firmId, scope.clientId, {
    userId: scope.userId,
  });
  await db
    .update(partiesTable)
    .set({
      createdByFirmId: scope.firmId,
      createdByUserId: scope.siblingUserId,
    })
    .where(eq(partiesTable.id, scope.buyerId));
  await db
    .update(partiesTable)
    .set({ createdByFirmId: other.firmId, createdByUserId: scope.userId })
    .where(eq(partiesTable.id, other.buyerId));
  assert.equal(step(await today(principal), "first_customer").complete, false);
  await db
    .update(partiesTable)
    .set({ createdByFirmId: scope.firmId, createdByUserId: scope.userId })
    .where(eq(partiesTable.id, scope.buyerId));
  assert.equal(step(await today(principal), "first_customer").complete, true);
  await db
    .update(partiesTable)
    .set({ mergedIntoId: scope.otherBuyerId })
    .where(eq(partiesTable.id, scope.buyerId));
  assert.equal(step(await today(principal), "first_customer").complete, false);
  await db
    .update(partiesTable)
    .set({ street: null })
    .where(eq(partiesTable.id, scope.clientId));
  assert.equal(
    step(await today(principal), "business_identity").complete,
    false,
    "TIN without an address is incomplete",
  );
});

test("declined consent is a recorded decision, not a submission capability or prerequisite to drafting", async () => {
  const scope = await makeScope(false);
  await getDb()
    .insert(consentRecordsTable)
    .values(
      [1, 2].map((layer) => ({
        partyId: scope.clientId,
        layer,
        action: "revoke" as const,
        scope: layer === 1 ? "compliance_submission" : "anonymized_benchmark",
        basis: "declined",
        channel: "first_landing",
      })),
    );
  await invoice(scope);
  const body = await today(
    clientPrincipal(scope.firmId, scope.clientId, { userId: scope.userId }),
  );
  assert.equal(step(body, "consent").complete, true);
  assert.equal(step(body, "first_invoice").complete, true);
  assert.equal(
    body.setup.some((item) => item.id === "invoice_submission"),
    true,
  );
  assert.equal(step(body, "invoice_consent").complete, false);
  assert.equal(step(body, "invoice_submission").complete, false);
  await getDb()
    .update(featureFlagOverridesTable)
    .set({ enabled: true })
    .where(
      and(
        eq(featureFlagOverridesTable.firmId, scope.firmId),
        eq(featureFlagOverridesTable.flagKey, "erp_connectors"),
      ),
    );
  const staff = await today(
    firmPrincipal(scope.firmId, { userId: scope.userId, role: "firm_staff" }),
  );
  const admin = await today(
    firmPrincipal(scope.firmId, { userId: scope.userId }),
  );
  assert.equal(
    staff.setup.some((item) => item.id === "first_connection"),
    false,
  );
  assert.equal(step(admin, "first_connection").complete, false);
  assert.match(
    step(admin, "first_connection").description,
    /verification is checked separately/,
  );
});

test("firm onboarding skips the oldest archived client and anchors all proofs to the next live client", async () => {
  const scope = await makeScope(false);
  const db = getDb();
  const archivedInvoice = await invoice(scope, { status: "validated" });
  await db.insert(invoiceLifecycleEventsTable).values({
    invoiceId: archivedInvoice,
    firmId: scope.firmId,
    fromStatus: "draft",
    toStatus: "validated",
  });
  await db
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(
      and(
        eq(engagementsTable.firmId, scope.firmId),
        eq(engagementsTable.clientPartyId, scope.clientId),
      ),
    );
  const principal = firmPrincipal(scope.firmId, { userId: scope.userId });
  let body = await today(principal);
  assert.equal(step(body, "first_client").complete, true);
  assert.equal(
    step(body, "business_identity").href,
    `/clients/${scope.siblingId}/business`,
  );
  assert.equal(
    step(body, "business_identity").complete,
    false,
    "the archived client's complete details are not reused",
  );
  for (const id of [
    "first_customer",
    "first_invoice",
    "invoice_validation",
    "invoice_evidence",
  ]) {
    assert.equal(
      step(body, id).complete,
      false,
      `${id} must not inherit archived-client proof`,
    );
  }
  const siblingInvoice = await invoice(scope, {
    supplierPartyId: scope.siblingId,
    buyerPartyId: scope.otherBuyerId,
  });
  body = await today(principal);
  assert.equal(step(body, "first_invoice").complete, true);
  assert.equal(
    step(body, "first_invoice").href,
    `/clients/${scope.siblingId}?view=invoices&invoiceId=${siblingInvoice}`,
  );
  assert.equal(step(body, "invoice_validation").complete, false);
  assert.equal(step(body, "invoice_evidence").complete, false);
});

test("submission setup honours current consent and a different approver on the current revision", async (t) => {
  setRailTransport({
    name: "test-live-provider",
    environment: "live",
    async submit() {
      throw new Error("Readiness must not call a provider");
    },
    async lookup() {
      throw new Error("Readiness must not call a provider");
    },
  });
  t.after(() => setRailTransport(null));
  const scope = await makeScope(false);
  const db = getDb();
  const id = await invoice(scope, { status: "validated", contentRevision: 2 });
  const principal = clientPrincipal(scope.firmId, scope.clientId, {
    userId: scope.userId,
  });
  await db
    .insert(firmPoliciesTable)
    .values({ firmId: scope.firmId, submitApprovalRequired: true });
  await db.insert(invoiceApprovalsTable).values([
    {
      firmId: scope.firmId,
      invoiceId: id,
      approvedByUserId: scope.userId,
      contentRevision: 2,
    },
    {
      firmId: scope.firmId,
      invoiceId: id,
      approvedByUserId: scope.siblingUserId,
      contentRevision: 1,
    },
  ]);
  let body = await today(principal);
  assert.equal(step(body, "invoice_approval").complete, false);
  assert.equal(step(body, "invoice_consent").complete, false);
  assert.match(
    step(body, "invoice_submission").blockedReason ?? "",
    /different authorised reviewer/,
  );
  await db.insert(invoiceApprovalsTable).values({
    firmId: scope.firmId,
    invoiceId: id,
    approvedByUserId: scope.siblingUserId,
    contentRevision: 2,
  });
  await db.insert(consentRecordsTable).values({
    partyId: scope.clientId,
    layer: 1,
    action: "grant",
    scope: "compliance_submission",
    basis: "consent",
    channel: "test",
    createdAt: new Date("2026-01-01"),
  });
  body = await today(principal);
  assert.equal(step(body, "invoice_service").complete, true);
  assert.equal(step(body, "invoice_approval").complete, true);
  assert.equal(step(body, "invoice_consent").complete, true);
  assert.equal(step(body, "invoice_submission").blockedReason, undefined);
  assert.equal(step(body, "invoice_submission").complete, false);
  assert.equal(step(body, "invoice_acknowledgement").complete, false);
  await db.insert(consentRecordsTable).values({
    partyId: scope.clientId,
    layer: 1,
    action: "revoke",
    scope: "compliance_submission",
    basis: "withdrawn",
    channel: "test",
    createdAt: new Date("2026-01-02"),
  });
  body = await today(principal);
  assert.equal(step(body, "invoice_consent").complete, false);
  assert.match(
    step(body, "invoice_submission").blockedReason ?? "",
    /grant submission consent/,
  );
});

test("live acceptance is tied to the same client's production stamp, not a sibling or service cutover", async (t) => {
  setRailTransport({
    name: "test-live-provider",
    environment: "live",
    async submit() {
      throw new Error("No live calls");
    },
    async lookup() {
      throw new Error("No live calls");
    },
  });
  t.after(() => setRailTransport(null));
  const scope = await makeScope(false);
  const db = getDb();
  const sibling = await invoice(scope, {
    supplierPartyId: scope.siblingId,
    status: "stamped",
  });
  const id = await invoice(scope, { status: "stamped" });
  await db.insert(stampRecordsTable).values([
    {
      invoiceId: sibling,
      irn: "private-sibling-irn",
      csid: "sibling-csid",
      qrPayload: "cXI=",
      signedArtifactRef: "sibling-artifact",
      rail: "rail_primary",
      provider: "test-provider",
      environment: "live",
    },
    {
      invoiceId: id,
      irn: "test-irn",
      csid: "test-csid",
      qrPayload: "cXI=",
      signedArtifactRef: "test-artifact",
      rail: "rail_primary",
      provider: "simulator",
      environment: "sandbox",
    },
  ]);
  const principal = clientPrincipal(scope.firmId, scope.clientId, {
    userId: scope.userId,
  });
  let body = await today(principal);
  assert.equal(step(body, "invoice_acknowledgement").complete, false);
  assert.match(
    step(body, "invoice_acknowledgement").description,
    /test or incomplete/,
  );
  assert.doesNotMatch(
    JSON.stringify(body),
    /private-sibling-irn|sibling-artifact/,
  );
  const other = await makeScope(false);
  const liveId = await invoice(other, { status: "stamped" });
  await db.insert(stampRecordsTable).values({
    invoiceId: liveId,
    irn: "live-irn",
    csid: "live-csid",
    qrPayload: "cXI=",
    signedArtifactRef: "live-artifact",
    rail: "rail_primary",
    provider: "test-provider",
    environment: "live",
  });
  body = await today(
    clientPrincipal(other.firmId, other.clientId, { userId: other.userId }),
  );
  assert.equal(step(body, "invoice_acknowledgement").complete, true);
  assert.equal(
    step(body, "invoice_acknowledgement").href,
    `/invoices/${liveId}`,
  );
});

test("all-archived firm onboarding stays incomplete until that firm re-engages a client", async () => {
  const scope = await makeScope(false);
  const other = await makeScope(false);
  const db = getDb();
  await invoice(scope, { status: "validated" });
  await db
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(eq(engagementsTable.firmId, scope.firmId));
  await db.insert(engagementsTable).values({
    firmId: other.firmId,
    clientPartyId: scope.clientId,
    type: "retainer",
    status: "open",
    title: "Another firm's live relationship",
  });
  const principal = firmPrincipal(scope.firmId, { userId: scope.userId });
  let body = await today(principal);
  for (const id of [
    "first_client",
    "business_identity",
    "first_customer",
    "first_invoice",
    "invoice_validation",
    "invoice_evidence",
  ]) {
    assert.equal(
      step(body, id).complete,
      false,
      `${id} requires this firm's live client`,
    );
  }
  assert.equal(
    step(body, "business_identity").href,
    "/portfolio?action=add-client",
  );
  await db.insert(engagementsTable).values({
    firmId: scope.firmId,
    clientPartyId: scope.clientId,
    type: "retainer",
    status: "open",
    title: "Re-engaged client",
  });
  body = await today(principal);
  assert.equal(
    step(body, "first_client").complete,
    true,
    "an archived historical engagement must not exclude a new live one",
  );
  assert.equal(
    step(body, "business_identity").href,
    `/clients/${scope.clientId}/business`,
  );
  assert.equal(step(body, "first_invoice").complete, true);
});

test("client onboarding requires this firm's live engagement, like the firm branch (R114)", async () => {
  const scope = await makeScope(false);
  const db = getDb();
  await invoice(scope, { status: "validated" });
  await db
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(
      and(
        eq(engagementsTable.firmId, scope.firmId),
        eq(engagementsTable.clientPartyId, scope.clientId),
      ),
    );
  const principal = clientPrincipal(scope.firmId, scope.clientId, {
    userId: scope.userId,
  });
  let body = await today(principal);
  assert.equal(
    body.setup.some((item) => item.id === "first_client"),
    false,
    "a client user never sees the firm's add-client step",
  );
  for (const id of [
    "business_identity",
    "first_customer",
    "first_invoice",
    "invoice_validation",
    "invoice_evidence",
  ]) {
    assert.equal(
      step(body, id).complete,
      false,
      `${id} must not use an archived engagement's records as proof`,
    );
  }
  assert.equal(step(body, "business_identity").href, "/business");
  await db.insert(engagementsTable).values({
    firmId: scope.firmId,
    clientPartyId: scope.clientId,
    type: "retainer",
    status: "open",
    title: "Re-engaged client",
  });
  body = await today(principal);
  assert.equal(step(body, "business_identity").complete, true);
  assert.equal(step(body, "first_customer").complete, true);
  assert.equal(step(body, "first_invoice").complete, true);
  assert.equal(step(body, "invoice_validation").complete, true);
  assert.equal(
    step(body, "invoice_evidence").complete,
    false,
    "re-engagement restores the anchor, not history that was never recorded",
  );
});

test("firm onboarding does not use a non-business engagement as its client", async () => {
  const scope = await makeScope(false);
  const db = getDb();
  await db
    .update(partiesTable)
    .set({ createdAt: new Date("2010-01-01T00:00:00Z") })
    .where(eq(partiesTable.id, scope.buyerId));
  await db.insert(engagementsTable).values({
    firmId: scope.firmId,
    clientPartyId: scope.buyerId,
    type: "readiness_assessment",
    status: "open",
    title: "Non-client party",
  });
  const body = await today(
    firmPrincipal(scope.firmId, { userId: scope.userId }),
  );
  assert.equal(
    step(body, "business_identity").href,
    `/clients/${scope.clientId}/business`,
  );
  assert.match(step(body, "business_identity").description, /First client/);
});
