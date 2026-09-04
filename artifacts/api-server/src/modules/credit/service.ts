import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import {
  confirmationsTable,
  creditBacktestRunsTable,
  creditBankAccessEventsTable,
  creditKybChecksTable,
  eligibilityAssessmentsTable,
  engagementsTable,
  getDb,
  invoicesTable,
  membershipsTable,
  partiesTable,
  settlementEventsTable,
  stampRecordsTable,
  usersTable,
} from "@workspace/db";
import { canonicalJson } from "../../lib/canonical-json";
import { appendAudit } from "../audit/audit";
import type { Principal } from "../auth/rbac";
import { isPurposePermitted } from "../consent/consent";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";
import {
  CREDIT_POLICY,
  evaluateEligibility,
  type CreditPolicy,
  type EligibilityFacts,
  type ObservedSettlementSource,
} from "./engine";

const BACKTEST_MAX_ROWS = 5_000;
export const CREDIT_BACKTEST_MIN_SAMPLE = 30;

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

function toNgn(row: {
  currency: string;
  grandTotal: string;
  fxRateToNgn: string | null;
}): number | null {
  const amount = Number(row.grandTotal);
  const rate = row.currency === "NGN" ? 1 : Number(row.fxRateToNgn);
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isFinite(rate) ||
    rate <= 0
  ) {
    return null;
  }
  return Math.round(amount * rate * 100) / 100;
}

const iso = (value: Date): string => value.toISOString();

export function assessmentView(
  row: typeof eligibilityAssessmentsTable.$inferSelect,
) {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    firmId: row.firmId,
    decision: row.decision,
    score: row.score,
    scorecardVersion: row.scorecardVersion,
    rulesetVersion: row.rulesetVersion,
    features: row.features,
    rules: row.ruleResults,
    reasons: row.reasons,
    inputHash: row.inputHash,
    evaluatedAt: iso(row.evaluatedAt),
  };
}

async function existingAssessment(idempotencyKey: string) {
  const [row] = await getDb()
    .select()
    .from(eligibilityAssessmentsTable)
    .where(eq(eligibilityAssessmentsTable.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

async function loadEligibilitySource(invoiceId: string): Promise<{
  invoice: typeof invoicesTable.$inferSelect;
  facts: EligibilityFacts;
  evidence: Record<string, unknown>;
}> {
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) {
    throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  }

  const [[supplier], [buyer], [stamp], [confirmation], settlements, [kyb]] =
    await Promise.all([
      getDb()
        .select()
        .from(partiesTable)
        .where(eq(partiesTable.id, invoice.supplierPartyId))
        .limit(1),
      getDb()
        .select()
        .from(partiesTable)
        .where(eq(partiesTable.id, invoice.buyerPartyId))
        .limit(1),
      getDb()
        .select()
        .from(stampRecordsTable)
        .where(eq(stampRecordsTable.invoiceId, invoice.id))
        .limit(1),
      getDb()
        .select()
        .from(confirmationsTable)
        .where(eq(confirmationsTable.invoiceId, invoice.id))
        .orderBy(
          desc(confirmationsTable.createdAt),
          desc(confirmationsTable.id),
        )
        .limit(1),
      getDb()
        .select()
        .from(settlementEventsTable)
        .where(eq(settlementEventsTable.invoiceId, invoice.id))
        .orderBy(
          desc(settlementEventsTable.occurredAt),
          desc(settlementEventsTable.id),
        ),
      getDb()
        .select()
        .from(creditKybChecksTable)
        .where(
          and(
            eq(creditKybChecksTable.firmId, invoice.firmId),
            eq(creditKybChecksTable.partyId, invoice.supplierPartyId),
          ),
        )
        .orderBy(
          desc(creditKybChecksTable.checkedAt),
          desc(creditKybChecksTable.id),
        )
        .limit(1),
    ]);

  const lookback = new Date(`${invoice.issueDate}T00:00:00.000Z`);
  lookback.setUTCFullYear(lookback.getUTCFullYear() - 1);
  const lookbackDate = lookback.toISOString().slice(0, 10);
  const history = await getDb()
    .select({
      id: invoicesTable.id,
      buyerPartyId: invoicesTable.buyerPartyId,
      currency: invoicesTable.currency,
      grandTotal: invoicesTable.grandTotal,
      fxRateToNgn: invoicesTable.fxRateToNgn,
      status: invoicesTable.status,
    })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.supplierPartyId, invoice.supplierPartyId),
        gte(invoicesTable.issueDate, lookbackDate),
        lte(invoicesTable.issueDate, invoice.issueDate),
        inArray(invoicesTable.status, [
          "submitted",
          "stamped",
          "confirmed",
          "settled",
        ]),
      ),
    );
  const prior = history.filter((item) => item.id !== invoice.id);
  const invoiceAmountNgn = toNgn(invoice);
  const historyAmounts = history
    .map((item) => ({ ...item, amountNgn: toNgn(item) }))
    .filter(
      (item): item is typeof item & { amountNgn: number } =>
        item.amountNgn !== null,
    );
  const priorAmounts = prior
    .map((item) => toNgn(item))
    .filter((amount): amount is number => amount !== null);
  const exposureRows = historyAmounts.filter((item) =>
    ["submitted", "stamped", "confirmed"].includes(item.status),
  );
  const supplierOutstandingNgn =
    history.length === historyAmounts.length
      ? exposureRows.reduce((total, item) => total + item.amountNgn, 0)
      : null;
  const totalHistoryNgn = historyAmounts.reduce(
    (total, item) => total + item.amountNgn,
    0,
  );
  const buyerHistoryNgn = historyAmounts
    .filter((item) => item.buyerPartyId === invoice.buyerPartyId)
    .reduce((total, item) => total + item.amountNgn, 0);
  const buyerConcentrationBps =
    history.length === historyAmounts.length && totalHistoryNgn > 0
      ? Math.round((buyerHistoryNgn / totalHistoryNgn) * 10_000)
      : null;
  const priorAverage = priorAmounts.length
    ? priorAmounts.reduce((total, amount) => total + amount, 0) /
      priorAmounts.length
    : null;
  const volumeVsPriorAverageBps =
    invoiceAmountNgn !== null && priorAverage !== null && priorAverage > 0
      ? Math.round((invoiceAmountNgn / priorAverage) * 10_000)
      : null;

  const [reverseRows, buyerObservedRows] = await Promise.all([
    getDb()
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.supplierPartyId, invoice.buyerPartyId),
          eq(invoicesTable.buyerPartyId, invoice.supplierPartyId),
          gte(invoicesTable.issueDate, lookbackDate),
          lte(invoicesTable.issueDate, invoice.issueDate),
          inArray(invoicesTable.status, ["stamped", "confirmed", "settled"]),
        ),
      )
      .limit(50),
    getDb()
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.buyerPartyId, invoice.buyerPartyId),
          ne(invoicesTable.id, invoice.id),
          inArray(invoicesTable.status, ["confirmed", "settled"]),
        ),
      )
      .limit(50),
  ]);

  const observed = settlements.find(
    (event) =>
      event.source === "collection_account" ||
      event.source === "statement_match" ||
      (event.source === "buyer_flag" && event.paymentStatus === "paid"),
  );
  const settlementSource = (observed?.source ??
    null) as ObservedSettlementSource;
  const now = new Date();
  const kybVerified =
    kyb?.status === "verified" && kyb.expiresAt.getTime() > now.getTime();
  const sameTin = Boolean(
    supplier?.tin && buyer?.tin && supplier.tin.trim() === buyer.tin.trim(),
  );
  const facts: EligibilityFacts = {
    invoiceActive: ["submitted", "stamped", "confirmed", "settled"].includes(
      invoice.status,
    ),
    amountConvertible: invoiceAmountNgn !== null,
    stampVerified: Boolean(stamp?.irn && stamp.csid && stamp.signedArtifactRef),
    liveRailProvenance: stamp?.environment === "live",
    buyerConfirmed: confirmation?.state === "confirmed",
    noSetOffConfirmed:
      confirmation?.state === "confirmed" && confirmation.noSetOff,
    settlementObserved: Boolean(observed),
    settlementSource,
    kybVerified,
    invoiceAmountNgn,
    supplierOutstandingNgn,
    priorHistoryInvoices: prior.length,
    buyerConcentrationBps,
    buyerPriorObservations: buyerObservedRows.length,
    relatedPartySignal:
      invoice.supplierPartyId === invoice.buyerPartyId || sameTin,
    reverseTradeCount: reverseRows.length,
    volumeVsPriorAverageBps,
  };
  return {
    invoice,
    facts,
    evidence: {
      stampRecordId: stamp?.id ?? null,
      confirmationRecordId: confirmation?.id ?? null,
      settlementEventId: observed?.id ?? null,
      kybCheckId: kyb?.id ?? null,
      dataThrough: now.toISOString(),
    },
  };
}

export async function runEligibilityAssessment(
  principal: Principal,
  input: { invoiceId: string; idempotencyKey: string },
) {
  const replay = await existingAssessment(input.idempotencyKey);
  if (replay) {
    if (replay.invoiceId !== input.invoiceId) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used for another invoice",
        409,
      );
    }
    return assessmentView(replay);
  }

  const source = await loadEligibilitySource(input.invoiceId);
  if (!(await isFeatureEnabled("credit_readiness", source.invoice.firmId))) {
    throw new DomainError(
      "CREDIT_DARK",
      "Credit readiness is not enabled for this firm",
      404,
    );
  }
  if (
    !(await isPurposePermitted(
      source.invoice.supplierPartyId,
      "credit_scoring",
    ))
  ) {
    throw new DomainError(
      "CONSENT_REQUIRED",
      "Layer-3 credit-readiness consent is required",
      403,
    );
  }

  const result = evaluateEligibility(source.facts, CREDIT_POLICY);
  const sourceSnapshot = { facts: source.facts, evidence: source.evidence };
  const inputHash = digest({ sourceSnapshot, policy: CREDIT_POLICY });
  const [inserted] = await getDb()
    .insert(eligibilityAssessmentsTable)
    .values({
      invoiceId: source.invoice.id,
      firmId: source.invoice.firmId,
      supplierPartyId: source.invoice.supplierPartyId,
      buyerPartyId: source.invoice.buyerPartyId,
      decision: result.decision,
      eligible:
        result.decision === "eligible"
          ? "true"
          : result.decision === "manual_review"
            ? "review"
            : "false",
      score: result.score,
      scorecardVersion: CREDIT_POLICY.scorecardVersion,
      rulesetVersion: CREDIT_POLICY.rulesetVersion,
      features: result.features,
      ruleResults: result.rules,
      reasons: result.reasons,
      sourceSnapshot,
      policySnapshot: CREDIT_POLICY as unknown as Record<string, unknown>,
      inputHash,
      idempotencyKey: input.idempotencyKey,
      requestedByUserId: principal.userId,
    })
    .onConflictDoNothing()
    .returning();

  const row =
    inserted ??
    (await existingAssessment(input.idempotencyKey)) ??
    (
      await getDb()
        .select()
        .from(eligibilityAssessmentsTable)
        .where(
          and(
            eq(eligibilityAssessmentsTable.invoiceId, source.invoice.id),
            eq(
              eligibilityAssessmentsTable.scorecardVersion,
              CREDIT_POLICY.scorecardVersion,
            ),
            eq(eligibilityAssessmentsTable.inputHash, inputHash),
          ),
        )
        .limit(1)
    )[0];
  if (!row) {
    throw new DomainError(
      "ASSESSMENT_CONFLICT",
      "The assessment could not be recorded safely",
      409,
    );
  }
  if (row.invoiceId !== input.invoiceId) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotency key was already used for another invoice",
      409,
    );
  }
  if (inserted) {
    await appendAudit({
      actorId: principal.userId,
      actorRole: principal.role,
      firmId: row.firmId,
      action: "credit.assessment.created",
      entityType: "eligibility_assessment",
      entityId: row.id,
      after: {
        invoiceId: row.invoiceId,
        decision: row.decision,
        scorecardVersion: row.scorecardVersion,
        inputHash: row.inputHash,
      },
    });
  }
  return assessmentView(row);
}

export interface RecordKybInput {
  firmId: string;
  partyId: string;
  idempotencyKey: string;
  beneficialOwnerCount: number;
  ownershipCoverageBps: number;
  beneficialOwnersVerified: boolean;
  bankAccountOwnership: "not_checked" | "verified" | "review" | "failed";
  sanctionsScreening: "not_checked" | "verified" | "review" | "failed";
  pepScreening: "not_checked" | "verified" | "review" | "failed";
  adverseMediaScreening: "not_checked" | "verified" | "review" | "failed";
  provider: string;
  providerReference?: string | null;
  evidenceRefs: string[];
  checkedAt: string;
  expiresAt: string;
}

function deriveKybStatus(input: RecordKybInput) {
  const expiresAt = new Date(input.expiresAt);
  if (expiresAt.getTime() <= Date.now()) return "expired" as const;
  const states = [
    input.bankAccountOwnership,
    input.sanctionsScreening,
    input.pepScreening,
    input.adverseMediaScreening,
  ];
  if (states.includes("failed")) return "failed" as const;
  if (
    !input.beneficialOwnersVerified ||
    input.ownershipCoverageBps < 10_000 ||
    states.some((state) => state !== "verified")
  ) {
    return "review" as const;
  }
  return "verified" as const;
}

export function kybView(row: typeof creditKybChecksTable.$inferSelect) {
  return {
    id: row.id,
    firmId: row.firmId,
    partyId: row.partyId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    beneficialOwnerCount: row.beneficialOwnerCount,
    ownershipCoverageBps: row.ownershipCoverageBps,
    beneficialOwnersVerified: row.beneficialOwnersVerified,
    bankAccountOwnership: row.bankAccountOwnership,
    sanctionsScreening: row.sanctionsScreening,
    pepScreening: row.pepScreening,
    adverseMediaScreening: row.adverseMediaScreening,
    provider: row.provider,
    providerReference: row.providerReference,
    evidenceRefs: row.evidenceRefs,
    checkedAt: iso(row.checkedAt),
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

export async function recordKybCheck(
  principal: Principal,
  input: RecordKybInput,
) {
  const [existing] = await getDb()
    .select()
    .from(creditKybChecksTable)
    .where(eq(creditKybChecksTable.idempotencyKey, input.idempotencyKey))
    .limit(1);
  const inputHash = digest(input);
  if (existing) {
    if (existing.inputHash !== inputHash) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used with different KYB evidence",
        409,
      );
    }
    return kybView(existing);
  }
  const [[engagement], [party]] = await Promise.all([
    getDb()
      .select({ id: engagementsTable.id })
      .from(engagementsTable)
      .where(
        and(
          eq(engagementsTable.firmId, input.firmId),
          eq(engagementsTable.clientPartyId, input.partyId),
        ),
      )
      .limit(1),
    getDb()
      .select({ type: partiesTable.type })
      .from(partiesTable)
      .where(eq(partiesTable.id, input.partyId))
      .limit(1),
  ]);
  if (!engagement || party?.type !== "client_business") {
    throw new DomainError(
      "INVALID_KYB_SUBJECT",
      "KYB subject must be a client business engaged by the named firm",
      400,
    );
  }
  if (!(await isFeatureEnabled("credit_readiness", input.firmId))) {
    throw new DomainError(
      "CREDIT_DARK",
      "Credit readiness is not enabled",
      404,
    );
  }
  if (!(await isPurposePermitted(input.partyId, "credit_scoring"))) {
    throw new DomainError(
      "CONSENT_REQUIRED",
      "Layer-3 credit-readiness consent is required",
      403,
    );
  }
  const checkedAt = new Date(input.checkedAt);
  const expiresAt = new Date(input.expiresAt);
  if (checkedAt.getTime() > Date.now() + 5 * 60_000 || expiresAt <= checkedAt) {
    throw new DomainError(
      "INVALID_KYB_WINDOW",
      "KYB timestamps do not form a valid verification window",
      400,
    );
  }
  const [row] = await getDb()
    .insert(creditKybChecksTable)
    .values({
      firmId: input.firmId,
      partyId: input.partyId,
      status: deriveKybStatus(input),
      beneficialOwnerCount: input.beneficialOwnerCount,
      ownershipCoverageBps: input.ownershipCoverageBps,
      beneficialOwnersVerified: input.beneficialOwnersVerified,
      bankAccountOwnership: input.bankAccountOwnership,
      sanctionsScreening: input.sanctionsScreening,
      pepScreening: input.pepScreening,
      adverseMediaScreening: input.adverseMediaScreening,
      provider: input.provider,
      providerReference: input.providerReference ?? null,
      evidenceRefs: input.evidenceRefs,
      checkedAt,
      expiresAt,
      checkedByUserId: principal.userId,
      inputHash,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: creditKybChecksTable.idempotencyKey })
    .returning();
  const resolved =
    row ??
    (
      await getDb()
        .select()
        .from(creditKybChecksTable)
        .where(eq(creditKybChecksTable.idempotencyKey, input.idempotencyKey))
        .limit(1)
    )[0];
  if (!resolved || resolved.inputHash !== inputHash) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "The KYB check could not be recorded safely",
      409,
    );
  }
  if (row) {
    await appendAudit({
      actorId: principal.userId,
      actorRole: principal.role,
      firmId: input.firmId,
      action: "credit.kyb.recorded",
      entityType: "credit_kyb_check",
      entityId: row.id,
      after: { partyId: input.partyId, status: row.status },
    });
  }
  return kybView(resolved);
}

export interface RecordBankAccessInput {
  bankPartyId: string;
  userId: string;
  action: "grant" | "suspend" | "revoke";
  dpaReference?: string | null;
  dpaExecutedAt?: string | null;
  validUntil?: string | null;
  reason: string;
  idempotencyKey: string;
}

export function bankAccessView(
  row: typeof creditBankAccessEventsTable.$inferSelect,
) {
  return {
    id: row.id,
    bankPartyId: row.bankPartyId,
    userId: row.userId,
    action: row.action,
    dpaReference: row.dpaReference,
    dpaExecutedAt: row.dpaExecutedAt ? iso(row.dpaExecutedAt) : null,
    validUntil: row.validUntil ? iso(row.validUntil) : null,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  };
}

export async function recordBankAccess(
  principal: Principal,
  input: RecordBankAccessInput,
) {
  const inputHash = digest(input);
  const [existing] = await getDb()
    .select()
    .from(creditBankAccessEventsTable)
    .where(eq(creditBankAccessEventsTable.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing) {
    if (existing.inputHash !== inputHash) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used with different bank access data",
        409,
      );
    }
    return bankAccessView(existing);
  }
  const [[bank], [membership], [user]] = await Promise.all([
    getDb()
      .select({ type: partiesTable.type })
      .from(partiesTable)
      .where(eq(partiesTable.id, input.bankPartyId))
      .limit(1),
    getDb()
      .select({ id: membershipsTable.id })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, input.userId),
          eq(membershipsTable.role, "bank_user"),
        ),
      )
      .limit(1),
    getDb()
      .select({ totpEnabledAt: usersTable.totpEnabledAt })
      .from(usersTable)
      .where(eq(usersTable.id, input.userId))
      .limit(1),
  ]);
  if (bank?.type !== "bank" || !membership || !user) {
    throw new DomainError(
      "INVALID_BANK_ACCESS",
      "Access requires a bank Party and a bank-user membership",
      400,
    );
  }
  if (input.action === "grant") {
    if (!user.totpEnabledAt) {
      throw new DomainError(
        "MFA_REQUIRED",
        "The bank user must activate TOTP before access can be granted",
        409,
      );
    }
    const dpaExecutedAt = input.dpaExecutedAt
      ? new Date(input.dpaExecutedAt)
      : null;
    const validUntil = input.validUntil ? new Date(input.validUntil) : null;
    if (
      !input.dpaReference?.trim() ||
      !dpaExecutedAt ||
      dpaExecutedAt.getTime() > Date.now() + 5 * 60_000 ||
      (validUntil && validUntil.getTime() <= Date.now())
    ) {
      throw new DomainError(
        "DPA_REQUIRED",
        "A current executed DPA and valid access window are required",
        400,
      );
    }
  }
  const [row] = await getDb()
    .insert(creditBankAccessEventsTable)
    .values({
      bankPartyId: input.bankPartyId,
      userId: input.userId,
      action: input.action,
      dpaReference: input.dpaReference?.trim() || null,
      dpaExecutedAt: input.dpaExecutedAt ? new Date(input.dpaExecutedAt) : null,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      reason: input.reason.trim(),
      actorId: principal.userId,
      idempotencyKey: input.idempotencyKey,
      inputHash,
    })
    .onConflictDoNothing({ target: creditBankAccessEventsTable.idempotencyKey })
    .returning();
  const resolved =
    row ??
    (
      await getDb()
        .select()
        .from(creditBankAccessEventsTable)
        .where(
          eq(creditBankAccessEventsTable.idempotencyKey, input.idempotencyKey),
        )
        .limit(1)
    )[0];
  if (!resolved || resolved.inputHash !== inputHash) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "The bank access event could not be recorded safely",
      409,
    );
  }
  if (row) {
    await appendAudit({
      actorId: principal.userId,
      actorRole: principal.role,
      action: `credit.bank_access.${row.action}`,
      entityType: "credit_bank_access",
      entityId: row.id,
      after: {
        bankPartyId: row.bankPartyId,
        userId: row.userId,
        dpaReference: row.dpaReference,
        validUntil: row.validUntil?.toISOString() ?? null,
      },
    });
  }
  return bankAccessView(resolved);
}

function isFacts(value: unknown): value is EligibilityFacts {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EligibilityFacts>;
  const nullableNumber = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "number" && Number.isFinite(candidate));
  return (
    typeof item.invoiceActive === "boolean" &&
    typeof item.amountConvertible === "boolean" &&
    typeof item.stampVerified === "boolean" &&
    typeof item.liveRailProvenance === "boolean" &&
    typeof item.buyerConfirmed === "boolean" &&
    typeof item.noSetOffConfirmed === "boolean" &&
    typeof item.settlementObserved === "boolean" &&
    (item.settlementSource === null ||
      item.settlementSource === "statement_match" ||
      item.settlementSource === "buyer_flag" ||
      item.settlementSource === "collection_account") &&
    typeof item.kybVerified === "boolean" &&
    nullableNumber(item.invoiceAmountNgn) &&
    nullableNumber(item.supplierOutstandingNgn) &&
    typeof item.priorHistoryInvoices === "number" &&
    Number.isInteger(item.priorHistoryInvoices) &&
    item.priorHistoryInvoices >= 0 &&
    nullableNumber(item.buyerConcentrationBps) &&
    typeof item.buyerPriorObservations === "number" &&
    Number.isInteger(item.buyerPriorObservations) &&
    item.buyerPriorObservations >= 0 &&
    typeof item.relatedPartySignal === "boolean" &&
    typeof item.reverseTradeCount === "number" &&
    Number.isInteger(item.reverseTradeCount) &&
    item.reverseTradeCount >= 0 &&
    nullableNumber(item.volumeVsPriorAverageBps)
  );
}

function isPolicy(value: unknown): value is CreditPolicy {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CreditPolicy>;
  const positive = (candidate: unknown) =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate > 0;
  return (
    typeof item.scorecardVersion === "string" &&
    typeof item.rulesetVersion === "string" &&
    positive(item.maxInvoiceAmountNgn) &&
    positive(item.maxSupplierOutstandingNgn) &&
    positive(item.maxBuyerConcentrationBps) &&
    positive(item.volumeAnomalyMultiplierBps) &&
    positive(item.minimumHistoryInvoices) &&
    positive(item.minimumBuyerObservations) &&
    Array.isArray(item.permittedSettlementSources) &&
    item.permittedSettlementSources.length === 3 &&
    new Set(item.permittedSettlementSources).size === 3 &&
    item.permittedSettlementSources.every((source) =>
      ["statement_match", "buyer_flag", "collection_account"].includes(source),
    )
  );
}

export function backtestView(row: typeof creditBacktestRunsTable.$inferSelect) {
  return {
    id: row.id,
    fromDate: row.fromDate,
    toDate: row.toDate,
    scorecardVersion: row.scorecardVersion,
    rulesetVersion: row.rulesetVersion,
    structuralOnly: row.structuralOnly,
    sampleSize: row.sampleSize,
    passed: row.passed,
    metrics: row.metrics,
    inputHash: row.inputHash,
    createdAt: iso(row.createdAt),
  };
}

export async function runStructuralBacktest(
  principal: Principal,
  input: { fromDate: string; toDate: string; idempotencyKey: string },
) {
  if (input.fromDate > input.toDate) {
    throw new DomainError(
      "INVALID_DATE_RANGE",
      "fromDate must be on or before toDate",
      400,
    );
  }
  const [existing] = await getDb()
    .select()
    .from(creditBacktestRunsTable)
    .where(eq(creditBacktestRunsTable.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing) {
    if (
      existing.fromDate !== input.fromDate ||
      existing.toDate !== input.toDate
    ) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used for another back-test range",
        409,
      );
    }
    return backtestView(existing);
  }

  const rows = await getDb()
    .select({
      assessment: eligibilityAssessmentsTable,
      issueDate: invoicesTable.issueDate,
    })
    .from(eligibilityAssessmentsTable)
    .innerJoin(
      invoicesTable,
      eq(invoicesTable.id, eligibilityAssessmentsTable.invoiceId),
    )
    .where(
      and(
        gte(invoicesTable.issueDate, input.fromDate),
        lte(invoicesTable.issueDate, input.toDate),
      ),
    )
    .orderBy(
      desc(eligibilityAssessmentsTable.evaluatedAt),
      desc(eligibilityAssessmentsTable.id),
    )
    .limit(BACKTEST_MAX_ROWS);
  const latest = new Map<string, (typeof rows)[number]["assessment"]>();
  for (const item of rows) {
    if (!latest.has(item.assessment.invoiceId)) {
      latest.set(item.assessment.invoiceId, item.assessment);
    }
  }
  let completeInputs = 0;
  let replayMatches = 0;
  let mandatorySourceComplete = 0;
  let eligible = 0;
  let ineligible = 0;
  let manualReview = 0;
  for (const row of latest.values()) {
    if (row.decision === "eligible") eligible++;
    else if (row.decision === "manual_review") manualReview++;
    else ineligible++;
    const source = row.sourceSnapshot as { facts?: unknown };
    if (!isFacts(source.facts) || !isPolicy(row.policySnapshot)) continue;
    completeInputs++;
    if (
      source.facts.stampVerified &&
      source.facts.buyerConfirmed &&
      source.facts.settlementObserved
    ) {
      mandatorySourceComplete++;
    }
    const replay = evaluateEligibility(source.facts, row.policySnapshot);
    if (
      replay.decision === row.decision &&
      replay.score === row.score &&
      canonicalJson(replay.rules) === canonicalJson(row.ruleResults)
    ) {
      replayMatches++;
    }
  }
  const sampleSize = latest.size;
  const driftCount = completeInputs - replayMatches;
  const passed =
    sampleSize >= CREDIT_BACKTEST_MIN_SAMPLE &&
    completeInputs === sampleSize &&
    driftCount === 0;
  const metrics = {
    sampleSize,
    minimumSample: CREDIT_BACKTEST_MIN_SAMPLE,
    sampleCapped: rows.length === BACKTEST_MAX_ROWS,
    completeInputs,
    replayMatches,
    driftCount,
    mandatorySourceComplete,
    eligible,
    ineligible,
    manualReview,
    predictivePerformanceMeasured: false,
  };
  const inputHash = digest({
    fromDate: input.fromDate,
    toDate: input.toDate,
    rows: [...latest.values()].map((row) => ({
      id: row.id,
      hash: row.inputHash,
    })),
  });
  const [row] = await getDb()
    .insert(creditBacktestRunsTable)
    .values({
      fromDate: input.fromDate,
      toDate: input.toDate,
      scorecardVersion: CREDIT_POLICY.scorecardVersion,
      rulesetVersion: CREDIT_POLICY.rulesetVersion,
      structuralOnly: true,
      sampleSize,
      passed,
      metrics,
      inputHash,
      idempotencyKey: input.idempotencyKey,
      runByUserId: principal.userId,
    })
    .onConflictDoNothing({ target: creditBacktestRunsTable.idempotencyKey })
    .returning();
  const resolved =
    row ??
    (
      await getDb()
        .select()
        .from(creditBacktestRunsTable)
        .where(eq(creditBacktestRunsTable.idempotencyKey, input.idempotencyKey))
        .limit(1)
    )[0];
  if (!resolved) {
    throw new DomainError(
      "BACKTEST_CONFLICT",
      "The back-test could not be recorded safely",
      409,
    );
  }
  if (row) {
    await appendAudit({
      actorId: principal.userId,
      actorRole: principal.role,
      action: "credit.backtest.completed",
      entityType: "credit_backtest_run",
      entityId: row.id,
      after: { passed, sampleSize, structuralOnly: true, inputHash },
    });
  }
  return backtestView(resolved);
}
