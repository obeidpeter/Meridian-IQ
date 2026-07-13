import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  partiesTable,
  engagementsTable,
  firmsTable,
  usersTable,
  membershipsTable,
  errorCatalogueTable,
  billingTiersTable,
  firmSubscriptionsTable,
  priceReviewsTable,
  onboardingProspectsTable,
  operatorCasesTable,
  revenueShareStatementsTable,
  escalationsTable,
  type Invoice,
  type BillingTier,
  type OperatorCase,
} from "@workspace/db";
import {
  GetPortfolioResponse,
  GetClientPortfolioParams,
  GetClientPortfolioResponse,
  ListFirmTeamResponse,
  ListPipelineResponse,
  CreateProspectBody,
  CreateProspectResponse,
  UpdateProspectParams,
  UpdateProspectBody,
  UpdateProspectResponse,
  GetUnearnedIncomeResponse,
  ListTiersResponse,
  UpdateTierParams,
  UpdateTierBody,
  UpdateTierResponse,
  ListPriceReviewsParams,
  ListPriceReviewsResponse,
  GetSubscriptionResponse,
  UpdateSubscriptionBody,
  UpdateSubscriptionResponse,
  ListStatementsQueryParams,
  ListStatementsResponse,
  GenerateStatementsBody,
  GenerateStatementsResponse,
  ListOperatorCasesQueryParams,
  ListOperatorCasesResponse,
  GetOperatorQueueStatsResponse,
  ClaimOperatorCaseParams,
  ClaimOperatorCaseResponse,
  ResolveOperatorCaseParams,
  ResolveOperatorCaseBody,
  ResolveOperatorCaseResponse,
  GetFirmReceivablesResponse,
} from "@workspace/api-zod";
import {
  assertCan,
  tenantFirmId,
  ROLE_CAPABILITIES,
  type Principal,
} from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";
import { DomainError } from "../modules/errors";
import { getFirmReceivables } from "../modules/invoice/receivables";

const router: IRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const SUBMISSION_WINDOW_DAYS = 7;

// Invoice statuses that count as processed volume for billing/overages.
const BILLED_STATUSES = ["submitted", "stamped", "confirmed", "settled"] as const;

function daysUntil(target: Date, from: Date): number {
  return Math.floor((target.getTime() - from.getTime()) / DAY_MS);
}

// The firm a console request is scoped to. Firm roles use their bound firm;
// cross-tenant staff (operator/auditor) fall back to their bound firm if any.
function firmScope(principal: Principal): string {
  const tenant = tenantFirmId(principal);
  if (tenant) return tenant;
  if (principal.firmId) return principal.firmId;
  throw new DomainError("NO_TENANT", "A firm context is required", 403);
}

type ClientRisk = {
  clientPartyId: string;
  legalName: string;
  totalInvoices: number;
  unsubmittedCount: number;
  unsubmittedValue: string;
  failedCount: number;
  pendingCount: number;
  stampedCount: number;
  overdueCount: number;
  penaltyRisk: "low" | "medium" | "high";
  nextDeadline: {
    id: string;
    clientPartyId: string;
    kind: string;
    title: string;
    description: string | null;
    dueDate: Date;
    status: string;
    severity: string;
    invoiceId: string | null;
  } | null;
  failingInvoiceIds: string[];
};

function isUnsubmitted(s: Invoice["status"]): boolean {
  return s === "draft" || s === "validated";
}
function isStamped(s: Invoice["status"]): boolean {
  return s === "stamped" || s === "confirmed" || s === "settled";
}

// Penalty-risk view for one client, computed from its invoice book plus the
// statutory submission window (CON-02). Deterministic so risk flags reflect the
// current data on every read (recompute-on-read, well under five minutes).
function computeClientRisk(
  clientPartyId: string,
  legalName: string,
  invoices: Invoice[],
): ClientRisk {
  const now = new Date();
  let unsubmittedCount = 0;
  let unsubmittedValue = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let stampedCount = 0;
  let overdueCount = 0;
  const failingInvoiceIds: string[] = [];
  let earliestOverdue: Date | null = null;
  let earliestOverdueInvoice: string | null = null;
  let dueSoon = false;

  for (const inv of invoices) {
    if (isUnsubmitted(inv.status)) {
      unsubmittedCount += 1;
      unsubmittedValue += Number(inv.grandTotal);
      const submitBy = new Date(new Date(inv.issueDate).getTime());
      submitBy.setUTCDate(submitBy.getUTCDate() + SUBMISSION_WINDOW_DAYS);
      const days = daysUntil(submitBy, now);
      if (days < 0) {
        overdueCount += 1;
        if (!earliestOverdue || submitBy < earliestOverdue) {
          earliestOverdue = submitBy;
          earliestOverdueInvoice = inv.id;
        }
      } else if (days <= 3) {
        dueSoon = true;
      }
    } else if (inv.status === "submitted") {
      pendingCount += 1;
    } else if (isStamped(inv.status)) {
      stampedCount += 1;
    } else if (inv.status === "failed") {
      failedCount += 1;
      failingInvoiceIds.push(inv.id);
    }
  }

  const penaltyRisk: "low" | "medium" | "high" =
    overdueCount > 0 || failedCount > 1
      ? "high"
      : failedCount > 0 || dueSoon
        ? "medium"
        : "low";

  const nextDeadline = earliestOverdue
    ? {
        id: `submit-${earliestOverdueInvoice}`,
        clientPartyId,
        kind: "penalty_watch",
        title: "Overdue invoice submission",
        description:
          "Past the submission window — may attract penalties until stamped.",
        dueDate: earliestOverdue,
        status: "overdue",
        severity: "critical",
        invoiceId: earliestOverdueInvoice,
      }
    : null;

  return {
    clientPartyId,
    legalName,
    totalInvoices: invoices.length,
    unsubmittedCount,
    unsubmittedValue: unsubmittedValue.toFixed(2),
    failedCount,
    pendingCount,
    stampedCount,
    overdueCount,
    penaltyRisk,
    nextDeadline,
    failingInvoiceIds,
  };
}

// The firm's client businesses (parties reached through an engagement).
async function loadFirmClients(
  firmId: string,
): Promise<{ id: string; legalName: string }[]> {
  const rows = await getDb()
    .selectDistinct({
      id: partiesTable.id,
      legalName: partiesTable.legalName,
    })
    .from(engagementsTable)
    .innerJoin(partiesTable, eq(engagementsTable.clientPartyId, partiesTable.id))
    .where(eq(engagementsTable.firmId, firmId));
  return rows;
}

// Receivables across the firm's whole book: who is owed (per client) and who
// owes (top debtors) — the advisor's chasing worklist, worst first.
router.get("/console/receivables", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const rollup = await getFirmReceivables(firmId);
  res.json(GetFirmReceivablesResponse.parse(rollup));
});

router.get("/console/portfolio", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const clients = await loadFirmClients(firmId);

  const risks: ClientRisk[] = [];
  for (const client of clients) {
    const invoices = await getDb()
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.firmId, firmId),
          eq(invoicesTable.supplierPartyId, client.id),
        ),
      )
      .orderBy(desc(invoicesTable.createdAt));
    risks.push(computeClientRisk(client.id, client.legalName, invoices));
  }

  // Riskiest clients first so the partner triages top-down.
  const order = { high: 0, medium: 1, low: 2 } as const;
  risks.sort((a, b) => order[a.penaltyRisk] - order[b.penaltyRisk]);

  const summary = {
    firmId,
    clientCount: risks.length,
    highRiskCount: risks.filter((r) => r.penaltyRisk === "high").length,
    totalUnsubmittedCount: risks.reduce((n, r) => n + r.unsubmittedCount, 0),
    totalUnsubmittedValue: risks
      .reduce((n, r) => n + Number(r.unsubmittedValue), 0)
      .toFixed(2),
    totalFailedCount: risks.reduce((n, r) => n + r.failedCount, 0),
    totalOverdueCount: risks.reduce((n, r) => n + r.overdueCount, 0),
    clients: risks,
  };
  res.json(GetPortfolioResponse.parse(summary));
});

router.get("/console/clients/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const params = GetClientPortfolioParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const firmId = firmScope(req.principal);
  const [client] = await getDb()
    .select({ id: partiesTable.id, legalName: partiesTable.legalName })
    .from(engagementsTable)
    .innerJoin(partiesTable, eq(engagementsTable.clientPartyId, partiesTable.id))
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, params.data.id),
      ),
    )
    .limit(1);
  if (!client) {
    throw new DomainError("NOT_FOUND", "Client not found in your firm", 404);
  }

  const invoices = await getDb()
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        eq(invoicesTable.supplierPartyId, client.id),
      ),
    )
    .orderBy(desc(invoicesTable.createdAt));

  const buyerIds = [...new Set(invoices.map((i) => i.buyerPartyId))];
  const buyers = buyerIds.length
    ? await getDb()
        .select({ id: partiesTable.id, legalName: partiesTable.legalName })
        .from(partiesTable)
        .where(inArray(partiesTable.id, buyerIds))
    : [];
  const buyerName = new Map(buyers.map((b) => [b.id, b.legalName]));

  const risk = computeClientRisk(client.id, client.legalName, invoices);
  const detail = {
    client: risk,
    invoices: invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      category: inv.category,
      issueDate: inv.issueDate,
      grandTotal: inv.grandTotal,
      buyerName: buyerName.get(inv.buyerPartyId) ?? "Unknown buyer",
      failing: inv.status === "failed",
    })),
    deadlines: risk.nextDeadline ? [risk.nextDeadline] : [],
  };
  res.json(GetClientPortfolioResponse.parse(detail));
});

router.get("/console/team", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const rows = await getDb()
    .select({
      userId: usersTable.id,
      fullName: usersTable.fullName,
      email: usersTable.email,
      role: membershipsTable.role,
      clientPartyId: membershipsTable.clientPartyId,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(membershipsTable.userId, usersTable.id))
    .where(eq(membershipsTable.firmId, firmId));
  const team = rows.map((r) => ({
    userId: r.userId,
    fullName: r.fullName,
    email: r.email,
    role: r.role,
    clientPartyId: r.clientPartyId,
    capabilities: ROLE_CAPABILITIES[r.role] ?? [],
  }));
  res.json(ListFirmTeamResponse.parse(team));
});

// --- Onboarding pipeline ----------------------------------------------------
router.get("/console/pipeline", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const rows = await getDb()
    .select()
    .from(onboardingProspectsTable)
    .where(eq(onboardingProspectsTable.firmId, firmId))
    .orderBy(desc(onboardingProspectsTable.createdAt));
  res.json(ListPipelineResponse.parse(rows));
});

router.post("/console/pipeline", async (req, res): Promise<void> => {
  // Managing the client book is a firm-admin write capability (auditors stay
  // read-only — a read cap must never gate a mutation).
  assertCan(req.principal, "pipeline.write");
  const parsed = CreateProspectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const firmId = firmScope(req.principal);
  const [row] = await getDb()
    .insert(onboardingProspectsTable)
    .values({
      firmId,
      name: parsed.data.name,
      contactEmail: parsed.data.contactEmail ?? null,
      stage: parsed.data.stage ?? "lead",
      estimatedMonthlyInvoices: parsed.data.estimatedMonthlyInvoices ?? 0,
      note: parsed.data.note ?? null,
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "pipeline.prospect.create",
    entityType: "onboarding_prospect",
    entityId: row.id,
    after: { name: row.name, stage: row.stage },
  });
  res.status(201).json(CreateProspectResponse.parse(row));
});

router.patch("/console/pipeline/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "pipeline.write");
  const params = UpdateProspectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateProspectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const firmId = firmScope(req.principal);
  const [existing] = await getDb()
    .select()
    .from(onboardingProspectsTable)
    .where(
      and(
        eq(onboardingProspectsTable.id, params.data.id),
        eq(onboardingProspectsTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new DomainError("NOT_FOUND", "Prospect not found", 404);
  }
  const [row] = await getDb()
    .update(onboardingProspectsTable)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.contactEmail !== undefined
        ? { contactEmail: parsed.data.contactEmail }
        : {}),
      ...(parsed.data.stage !== undefined ? { stage: parsed.data.stage } : {}),
      ...(parsed.data.estimatedMonthlyInvoices !== undefined
        ? { estimatedMonthlyInvoices: parsed.data.estimatedMonthlyInvoices }
        : {}),
      ...(parsed.data.clientPartyId !== undefined
        ? { clientPartyId: parsed.data.clientPartyId }
        : {}),
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    })
    .where(eq(onboardingProspectsTable.id, params.data.id))
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "pipeline.prospect.update",
    entityType: "onboarding_prospect",
    entityId: row.id,
    before: { stage: existing.stage },
    after: { stage: row.stage },
  });
  res.json(UpdateProspectResponse.parse(row));
});

// --- Billing helpers --------------------------------------------------------
async function tierForFirm(firmId: string): Promise<BillingTier> {
  const [sub] = await getDb()
    .select()
    .from(firmSubscriptionsTable)
    .where(eq(firmSubscriptionsTable.firmId, firmId))
    .limit(1);
  if (sub) {
    const [tier] = await getDb()
      .select()
      .from(billingTiersTable)
      .where(eq(billingTiersTable.id, sub.tierId))
      .limit(1);
    if (tier) return tier;
  }
  const [fallback] = await getDb()
    .select()
    .from(billingTiersTable)
    .where(eq(billingTiersTable.key, "essential"))
    .limit(1);
  if (!fallback) {
    throw new DomainError("NO_TIER", "No billing tiers configured", 500);
  }
  return fallback;
}

// Deterministic billing maths — subscription + per-invoice overage, then the
// firm's revenue share, all rounded to two decimals (kobo) so statements and
// the unearned-income view reconcile to the naira.
function computeBilling(tier: BillingTier, billedInvoices: number) {
  const included = tier.includedInvoices;
  const overageInvoices = Math.max(0, billedInvoices - included);
  const subscriptionAmount = Number(tier.monthlyPrice);
  const overageAmount = overageInvoices * Number(tier.overagePrice);
  const billingAmount = subscriptionAmount + overageAmount;
  const pct = Number(tier.revenueSharePct);
  const revenueShareAmount = billingAmount * pct;
  return {
    includedInvoices: included,
    overageInvoices,
    subscriptionAmount: subscriptionAmount.toFixed(2),
    overageAmount: overageAmount.toFixed(2),
    billingAmount: billingAmount.toFixed(2),
    revenueSharePct: pct.toString(),
    revenueShareAmount: revenueShareAmount.toFixed(2),
  };
}

router.get("/console/unearned-income", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const tier = await tierForFirm(firmId);
  const pct = Number(tier.revenueSharePct);
  const overagePrice = Number(tier.overagePrice);

  // Eligible-but-unconverted prospects (not yet live, not lost).
  const prospects = await getDb()
    .select()
    .from(onboardingProspectsTable)
    .where(eq(onboardingProspectsTable.firmId, firmId));
  const eligible = prospects.filter(
    (p) => p.stage !== "active" && p.stage !== "lost",
  );

  // A prospect adds incremental invoice volume to the firm's single
  // subscription, so its implied billing is the overage on that volume (not a
  // fresh subscription base). Totals are summed from the per-row rounded values
  // so the view reconciles to the naira against what each line displays.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let totalBilling = 0;
  let totalShare = 0;
  const rows = eligible.map((p) => {
    const impliedBilling = round2(p.estimatedMonthlyInvoices * overagePrice);
    const impliedShare = round2(impliedBilling * pct);
    totalBilling += impliedBilling;
    totalShare += impliedShare;
    return {
      id: p.id,
      name: p.name,
      stage: p.stage,
      estimatedMonthlyInvoices: p.estimatedMonthlyInvoices,
      impliedMonthlyBilling: impliedBilling.toFixed(2),
      impliedMonthlyRevenueShare: impliedShare.toFixed(2),
    };
  });

  const view = {
    firmId,
    tierKey: tier.key,
    revenueSharePct: pct.toString(),
    eligibleCount: eligible.length,
    impliedMonthlyBilling: totalBilling.toFixed(2),
    impliedMonthlyRevenueShare: totalShare.toFixed(2),
    impliedAnnualRevenueShare: (totalShare * 12).toFixed(2),
    prospects: rows,
  };
  res.json(GetUnearnedIncomeResponse.parse(view));
});

// --- Tiers & subscription ---------------------------------------------------
router.get("/billing/tiers", async (req, res): Promise<void> => {
  assertCan(req.principal, "billing.read");
  const rows = await getDb()
    .select()
    .from(billingTiersTable)
    .orderBy(billingTiersTable.sortOrder);
  res.json(ListTiersResponse.parse(rows));
});

const TIER_FIELDS = [
  "name",
  "description",
  "monthlyPrice",
  "includedInvoices",
  "overagePrice",
  "revenueSharePct",
  "active",
] as const;

router.put("/billing/tiers/:id", async (req, res): Promise<void> => {
  // billing_tiers is a platform-global table (no firm scope), so tier price
  // reviews are operator-only (SEC-04). A firm_admin's billing.write governs
  // only firm-scoped billing (its own subscription and revenue-share
  // statements) and must NOT reach the shared pricing rows. Recorded with an
  // audit entry + price-review history rows (PL-01).
  assertCan(req.principal, "billing.tiers.write");
  const params = UpdateTierParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateTierBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await getDb()
    .select()
    .from(billingTiersTable)
    .where(eq(billingTiersTable.id, params.data.id))
    .limit(1);
  if (!existing) {
    throw new DomainError("NOT_FOUND", "Tier not found", 404);
  }

  const effectiveDate =
    parsed.data.effectiveDate ?? new Date().toISOString().slice(0, 10);
  const changes: Record<string, unknown> = {};
  const reviewRows: {
    tierId: string;
    field: string;
    oldValue: string | null;
    newValue: string;
    note: string | null;
    effectiveDate: string;
    actorId: string | null;
  }[] = [];
  const record = existing as unknown as Record<string, unknown>;
  for (const field of TIER_FIELDS) {
    const next = (parsed.data as Record<string, unknown>)[field];
    if (next === undefined) continue;
    const oldVal = record[field];
    if (String(oldVal) === String(next)) continue;
    changes[field] = next;
    reviewRows.push({
      tierId: existing.id,
      field,
      oldValue: oldVal === null || oldVal === undefined ? null : String(oldVal),
      newValue: String(next),
      note: parsed.data.note ?? null,
      effectiveDate,
      actorId: req.principal.userId,
    });
  }

  if (reviewRows.length === 0) {
    res.json(UpdateTierResponse.parse(existing));
    return;
  }

  const [row] = await getDb()
    .update(billingTiersTable)
    .set(changes)
    .where(eq(billingTiersTable.id, existing.id))
    .returning();
  await getDb().insert(priceReviewsTable).values(reviewRows);
  await appendAudit({
    actorId: req.principal.userId,
    firmId: req.principal.firmId,
    action: "billing.tier.price_review",
    entityType: "billing_tier",
    entityId: existing.id,
    before: Object.fromEntries(
      reviewRows.map((r) => [r.field, r.oldValue]),
    ),
    after: changes,
  });
  res.json(UpdateTierResponse.parse(row));
});

router.get("/billing/tiers/:id/price-reviews", async (req, res): Promise<void> => {
  assertCan(req.principal, "billing.read");
  const params = ListPriceReviewsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await getDb()
    .select()
    .from(priceReviewsTable)
    .where(eq(priceReviewsTable.tierId, params.data.id))
    .orderBy(desc(priceReviewsTable.createdAt));
  res.json(ListPriceReviewsResponse.parse(rows));
});

router.get("/billing/subscription", async (req, res): Promise<void> => {
  assertCan(req.principal, "billing.read");
  const firmId = firmScope(req.principal);
  const [sub] = await getDb()
    .select()
    .from(firmSubscriptionsTable)
    .where(eq(firmSubscriptionsTable.firmId, firmId))
    .limit(1);
  const tier = await tierForFirm(firmId);
  res.json(
    GetSubscriptionResponse.parse({
      firmId,
      status: sub?.status ?? "active",
      startedAt: sub?.startedAt ?? null,
      tier,
    }),
  );
});

router.put("/billing/subscription", async (req, res): Promise<void> => {
  assertCan(req.principal, "billing.write");
  const parsed = UpdateSubscriptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const firmId = firmScope(req.principal);
  const [tier] = await getDb()
    .select()
    .from(billingTiersTable)
    .where(eq(billingTiersTable.key, parsed.data.tierKey))
    .limit(1);
  if (!tier) {
    throw new DomainError("NOT_FOUND", "Tier not found", 404);
  }
  const [sub] = await getDb()
    .insert(firmSubscriptionsTable)
    .values({
      firmId,
      tierId: tier.id,
      status: parsed.data.status ?? "active",
    })
    .onConflictDoUpdate({
      target: firmSubscriptionsTable.firmId,
      set: {
        tierId: tier.id,
        status: parsed.data.status ?? "active",
        updatedAt: new Date(),
      },
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "billing.subscription.update",
    entityType: "firm_subscription",
    entityId: sub.id,
    after: { tierKey: tier.key, status: sub.status },
  });
  res.json(
    GetSubscriptionResponse.parse({
      firmId,
      status: sub.status,
      startedAt: sub.startedAt,
      tier,
    }),
  );
});

// --- Revenue-share statements ----------------------------------------------
function periodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) {
    throw new DomainError("BAD_PERIOD", "Period must be YYYY-MM", 400);
  }
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start, end };
}

async function firmName(firmId: string): Promise<string | null> {
  const [f] = await getDb()
    .select({ name: firmsTable.name })
    .from(firmsTable)
    .where(eq(firmsTable.id, firmId))
    .limit(1);
  return f?.name ?? null;
}

router.get("/billing/statements", async (req, res): Promise<void> => {
  assertCan(req.principal, "billing.read");
  const query = ListStatementsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const tenant = tenantFirmId(req.principal);
  // Firm principals see their own statements; operator/auditor may pass firmId.
  const scope = tenant ?? query.data.firmId ?? null;
  const rows = scope
    ? await getDb()
        .select()
        .from(revenueShareStatementsTable)
        .where(eq(revenueShareStatementsTable.firmId, scope))
        .orderBy(desc(revenueShareStatementsTable.period))
    : await getDb()
        .select()
        .from(revenueShareStatementsTable)
        .orderBy(desc(revenueShareStatementsTable.period));

  const names = new Map<string, string | null>();
  for (const r of rows) {
    if (!names.has(r.firmId)) names.set(r.firmId, await firmName(r.firmId));
  }
  res.json(
    ListStatementsResponse.parse(
      rows.map((r) => ({ ...r, firmName: names.get(r.firmId) ?? null })),
    ),
  );
});

async function generateStatement(firmId: string, period: string) {
  const { start, end } = periodBounds(period);
  const tier = await tierForFirm(firmId);
  const [{ count }] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        inArray(invoicesTable.status, [...BILLED_STATUSES]),
        sql`${invoicesTable.issueDate} >= ${start.toISOString().slice(0, 10)}`,
        sql`${invoicesTable.issueDate} < ${end.toISOString().slice(0, 10)}`,
      ),
    );
  const billedInvoices = Number(count) || 0;
  const billing = computeBilling(tier, billedInvoices);
  const values = {
    firmId,
    period,
    tierKey: tier.key,
    billedInvoices,
    includedInvoices: billing.includedInvoices,
    overageInvoices: billing.overageInvoices,
    subscriptionAmount: billing.subscriptionAmount,
    overageAmount: billing.overageAmount,
    billingAmount: billing.billingAmount,
    revenueSharePct: billing.revenueSharePct,
    revenueShareAmount: billing.revenueShareAmount,
    breakdown: {
      tierName: tier.name,
      monthlyPrice: tier.monthlyPrice,
      overagePrice: tier.overagePrice,
    },
  };
  const [row] = await getDb()
    .insert(revenueShareStatementsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [
        revenueShareStatementsTable.firmId,
        revenueShareStatementsTable.period,
      ],
      set: { ...values, generatedAt: new Date() },
    })
    .returning();
  return row;
}

router.post("/billing/statements/generate", async (req, res): Promise<void> => {
  assertCan(req.principal, "billing.write");
  const parsed = GenerateStatementsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const tenant = tenantFirmId(req.principal);
  const targetFirm = tenant ?? parsed.data.firmId ?? req.principal.firmId;
  let firmIds: string[];
  if (targetFirm) {
    firmIds = [targetFirm];
  } else {
    // Operator generating for every firm that has a subscription.
    const subs = await getDb()
      .select({ firmId: firmSubscriptionsTable.firmId })
      .from(firmSubscriptionsTable);
    firmIds = subs.map((s) => s.firmId);
  }

  const out = [];
  for (const firmId of firmIds) {
    const row = await generateStatement(firmId, parsed.data.period);
    out.push({ ...row, firmName: await firmName(firmId) });
  }
  await appendAudit({
    actorId: req.principal.userId,
    firmId: req.principal.firmId,
    action: "billing.statements.generate",
    entityType: "revenue_share_statement",
    entityId: parsed.data.period,
    after: { period: parsed.data.period, firms: firmIds.length },
  });
  res.json(GenerateStatementsResponse.parse(out));
});

// --- Operator work queue (CON-04) -------------------------------------------
async function caseView(row: OperatorCase) {
  const [firm] = row.firmId
    ? await getDb()
        .select({ name: firmsTable.name })
        .from(firmsTable)
        .where(eq(firmsTable.id, row.firmId))
        .limit(1)
    : [];
  const [client] = row.clientPartyId
    ? await getDb()
        .select({ legalName: partiesTable.legalName })
        .from(partiesTable)
        .where(eq(partiesTable.id, row.clientPartyId))
        .limit(1)
    : [];
  const [invoice] = row.invoiceId
    ? await getDb()
        .select({ invoiceNumber: invoicesTable.invoiceNumber })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, row.invoiceId))
        .limit(1)
    : [];
  let playbook = null;
  if (row.errorCode) {
    const [entry] = await getDb()
      .select()
      .from(errorCatalogueTable)
      .where(eq(errorCatalogueTable.code, row.errorCode))
      .limit(1);
    if (entry) {
      playbook = {
        code: entry.code,
        category: entry.category,
        cause: entry.cause,
        fix: entry.fix,
        retriable: entry.retriable,
      };
    }
  }
  // SME-06: the operator sees what the client already reported and tried —
  // escalations ride along with the case, no re-entry.
  const escalations = row.invoiceId
    ? (
        await getDb()
          .select()
          .from(escalationsTable)
          .where(eq(escalationsTable.invoiceId, row.invoiceId))
          .orderBy(desc(escalationsTable.createdAt))
      ).map((e) => ({
        id: e.id,
        reason: e.reason,
        errorCode: e.errorCode,
        status: e.status,
        context: e.context,
        createdAt: e.createdAt,
      }))
    : [];
  return {
    id: row.id,
    firmId: row.firmId,
    firmName: firm?.name ?? null,
    clientPartyId: row.clientPartyId,
    clientName: client?.legalName ?? null,
    invoiceId: row.invoiceId,
    invoiceNumber: invoice?.invoiceNumber ?? null,
    title: row.title,
    errorCode: row.errorCode,
    priority: row.priority,
    status: row.status,
    assignedOperatorId: row.assignedOperatorId,
    resolutionCode: row.resolutionCode,
    resolutionNote: row.resolutionNote,
    openedAt: row.openedAt,
    firstActionAt: row.firstActionAt,
    resolvedAt: row.resolvedAt,
    handleSeconds: row.handleSeconds,
    playbook,
    escalations,
  };
}

router.get("/operator/cases", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const query = ListOperatorCasesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const priorityRank = { high: 0, medium: 1, low: 2 } as const;
  const rows = await getDb()
    .select()
    .from(operatorCasesTable)
    .where(
      query.data.status
        ? eq(operatorCasesTable.status, query.data.status)
        : undefined,
    )
    .orderBy(desc(operatorCasesTable.openedAt));
  rows.sort(
    (a, b) => priorityRank[a.priority] - priorityRank[b.priority],
  );
  const views = [];
  for (const row of rows) views.push(await caseView(row));
  res.json(ListOperatorCasesResponse.parse(views));
});

router.get("/operator/cases/stats", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const rows = await getDb().select().from(operatorCasesTable);
  const resolved = rows.filter(
    (r) => r.status === "resolved" && r.handleSeconds != null,
  );
  const avg = resolved.length
    ? Math.round(
        resolved.reduce((n, r) => n + (r.handleSeconds ?? 0), 0) /
          resolved.length,
      )
    : null;
  const clientsServed = new Set(
    rows.map((r) => r.clientPartyId).filter(Boolean),
  ).size;
  res.json(
    GetOperatorQueueStatsResponse.parse({
      openCount: rows.filter((r) => r.status === "open").length,
      inProgressCount: rows.filter((r) => r.status === "in_progress").length,
      resolvedCount: rows.filter((r) => r.status === "resolved").length,
      clientsServed,
      avgHandleSeconds: avg,
    }),
  );
});

async function loadCase(id: string): Promise<OperatorCase> {
  const [row] = await getDb()
    .select()
    .from(operatorCasesTable)
    .where(eq(operatorCasesTable.id, id))
    .limit(1);
  if (!row) throw new DomainError("NOT_FOUND", "Case not found", 404);
  return row;
}

router.post("/operator/cases/:id/claim", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const params = ClaimOperatorCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const existing = await loadCase(params.data.id);
  // Compare-and-set on status so two operators can't both claim the same open
  // case (lost update); the loser gets a 409 instead of a silent overwrite
  // (CON-M5).
  const [row] = await getDb()
    .update(operatorCasesTable)
    .set({
      status: "in_progress",
      assignedOperatorId: req.principal.userId,
      firstActionAt: existing.firstActionAt ?? new Date(),
    })
    .where(
      and(
        eq(operatorCasesTable.id, existing.id),
        eq(operatorCasesTable.status, "open"),
      ),
    )
    .returning();
  if (!row) {
    throw new DomainError(
      "CASE_NOT_CLAIMABLE",
      "Case is no longer open — it was claimed or resolved by another operator",
      409,
    );
  }
  await appendAudit({
    actorId: req.principal.userId,
    firmId: row.firmId,
    action: "operator.case.claim",
    entityType: "operator_case",
    entityId: row.id,
    after: { status: row.status },
  });
  res.json(ClaimOperatorCaseResponse.parse(await caseView(row)));
});

router.post("/operator/cases/:id/resolve", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const params = ResolveOperatorCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = ResolveOperatorCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await loadCase(params.data.id);
  const now = new Date();
  // Handling time is measured from the first operator action (claim), not the
  // moment the case opened — otherwise it counts queue wait as handling time.
  const handleStart = existing.firstActionAt ?? existing.openedAt;
  const handleSeconds = Math.max(
    0,
    Math.round((now.getTime() - handleStart.getTime()) / 1000),
  );
  // Compare-and-set: only an open/in-progress case can be resolved, so a
  // concurrent double-resolve loses the race with a 409 rather than
  // overwriting the first resolution (CON-M5).
  const [row] = await getDb()
    .update(operatorCasesTable)
    .set({
      status: "resolved",
      assignedOperatorId: existing.assignedOperatorId ?? req.principal.userId,
      firstActionAt: existing.firstActionAt ?? now,
      resolvedAt: now,
      handleSeconds,
      resolutionCode: parsed.data.resolutionCode,
      resolutionNote: parsed.data.note ?? null,
    })
    .where(
      and(
        eq(operatorCasesTable.id, existing.id),
        inArray(operatorCasesTable.status, ["open", "in_progress"]),
      ),
    )
    .returning();
  if (!row) {
    throw new DomainError(
      "CASE_ALREADY_RESOLVED",
      "Case has already been resolved",
      409,
    );
  }
  await appendAudit({
    actorId: req.principal.userId,
    firmId: row.firmId,
    action: "operator.case.resolve",
    entityType: "operator_case",
    entityId: row.id,
    after: { resolutionCode: row.resolutionCode, handleSeconds },
  });
  res.json(ResolveOperatorCaseResponse.parse(await caseView(row)));
});

export default router;
