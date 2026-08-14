import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  getDb,
  billingTiersTable,
  firmSubscriptionsTable,
  priceReviewsTable,
  onboardingProspectsTable,
  revenueShareStatementsTable,
} from "@workspace/db";
import {
  GetUnearnedIncomeResponse,
  ListTiersResponse,
  UpdateTierParams,
  UpdateTierBody,
  UpdateTierResponse,
  ListPriceReviewsParams,
  ListPriceReviewsResponse,
  GetSubscriptionResponse,
  UpdateSubscriptionBody,
  ListStatementsQueryParams,
  ListStatementsResponse,
  GenerateStatementsBody,
  GenerateStatementsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  firmScope,
  tenantFirmId,
} from "../../modules/auth/rbac";
import { appendAudit } from "../../modules/audit/audit";
import { DomainError } from "../../modules/errors";
import { billingTierForFirm } from "../../modules/invoice/billing-statement";
import {
  firmNamesById,
  generateRevenueShareStatement,
} from "../../modules/billing/revenue-share";

const router: IRouter = Router();

router.get("/console/unearned-income", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const tier = await billingTierForFirm(firmId);
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
  const params = parseOrThrow(UpdateTierParams, req.params);
  const parsed = parseOrThrow(UpdateTierBody, req.body);
  const [existing] = await getDb()
    .select()
    .from(billingTiersTable)
    .where(eq(billingTiersTable.id, params.id))
    .limit(1);
  if (!existing) {
    throw new DomainError("NOT_FOUND", "Tier not found", 404);
  }

  const effectiveDate =
    parsed.effectiveDate ?? new Date().toISOString().slice(0, 10);
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
    const next = (parsed as Record<string, unknown>)[field];
    if (next === undefined) continue;
    const oldVal = record[field];
    if (String(oldVal) === String(next)) continue;
    changes[field] = next;
    reviewRows.push({
      tierId: existing.id,
      field,
      oldValue: oldVal === null || oldVal === undefined ? null : String(oldVal),
      newValue: String(next),
      note: parsed.note ?? null,
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
  const params = parseOrThrow(ListPriceReviewsParams, req.params);
  const rows = await getDb()
    .select()
    .from(priceReviewsTable)
    .where(eq(priceReviewsTable.tierId, params.id))
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
  const tier = await billingTierForFirm(firmId);
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
  const parsed = parseOrThrow(UpdateSubscriptionBody, req.body);
  const firmId = firmScope(req.principal);
  const [tier] = await getDb()
    .select()
    .from(billingTiersTable)
    .where(eq(billingTiersTable.key, parsed.tierKey))
    .limit(1);
  if (!tier) {
    throw new DomainError("NOT_FOUND", "Tier not found", 404);
  }
  const [sub] = await getDb()
    .insert(firmSubscriptionsTable)
    .values({
      firmId,
      tierId: tier.id,
      status: parsed.status ?? "active",
    })
    .onConflictDoUpdate({
      target: firmSubscriptionsTable.firmId,
      set: {
        tierId: tier.id,
        status: parsed.status ?? "active",
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
// Generation and the batched firm-name lookup live in
// modules/billing/revenue-share.ts; the routes keep gating, the operator
// all-firms fan-out and the audit row.

router.get("/billing/statements", async (req, res): Promise<void> => {
  assertCan(req.principal, "billing.read");
  const query = parseOrThrow(ListStatementsQueryParams, req.query);
  const tenant = tenantFirmId(req.principal);
  // Firm principals see their own statements; operator/auditor may pass firmId.
  const scope = tenant ?? query.firmId ?? null;
  const rows = await getDb()
    .select()
    .from(revenueShareStatementsTable)
    .where(scope ? eq(revenueShareStatementsTable.firmId, scope) : undefined)
    .orderBy(desc(revenueShareStatementsTable.period));

  const names = await firmNamesById(rows.map((r) => r.firmId));
  res.json(
    ListStatementsResponse.parse(
      rows.map((r) => ({ ...r, firmName: names.get(r.firmId) ?? null })),
    ),
  );
});

router.post("/billing/statements/generate", async (req, res): Promise<void> => {
  assertCan(req.principal, "billing.write");
  const parsed = parseOrThrow(GenerateStatementsBody, req.body);
  const tenant = tenantFirmId(req.principal);
  const targetFirm = tenant ?? parsed.firmId ?? req.principal.firmId;
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

  const names = await firmNamesById(firmIds);
  const out = [];
  for (const firmId of firmIds) {
    const row = await generateRevenueShareStatement(firmId, parsed.period);
    out.push({ ...row, firmName: names.get(firmId) ?? null });
  }
  await appendAudit({
    actorId: req.principal.userId,
    firmId: req.principal.firmId,
    action: "billing.statements.generate",
    entityType: "revenue_share_statement",
    entityId: parsed.period,
    after: { period: parsed.period, firms: firmIds.length },
  });
  res.json(GenerateStatementsResponse.parse(out));
});

export default router;
