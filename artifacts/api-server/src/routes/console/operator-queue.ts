import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  partiesTable,
  firmsTable,
  errorCatalogueTable,
  operatorCasesTable,
  escalationsTable,
  type OperatorCase,
} from "@workspace/db";
import {
  ListOperatorCasesQueryParams,
  ListOperatorCasesResponse,
  GetOperatorQueueStatsResponse,
  ClaimOperatorCaseParams,
  ClaimOperatorCaseResponse,
  ResolveOperatorCaseParams,
  ResolveOperatorCaseBody,
  ResolveOperatorCaseResponse,
  DraftEscalationReplyParams,
  DraftEscalationReplyResponse,
  ReplyToEscalationParams,
  ReplyToEscalationBody,
  ReplyToEscalationResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { assertCan } from "../../modules/auth/rbac";
import { appendAudit } from "../../modules/audit/audit";
import { DomainError } from "../../modules/errors";
import {
  draftEscalationReply,
  sendEscalationReply,
} from "../../modules/desk/draft-reply";
import { gatewayOrNull } from "../../modules/clerk/provider";
import { PRIORITY_RANK } from "./shared";

const router: IRouter = Router();

// --- Operator work queue (CON-04) -------------------------------------------
type Playbook = {
  code: string;
  category: string;
  cause: string;
  fix: string;
  retriable: boolean;
} | null;
type EscalationView = {
  id: string;
  reason: string;
  errorCode: string | null;
  status: (typeof escalationsTable.$inferSelect)["status"];
  context: Record<string, unknown> | null;
  operatorReply: string | null;
  repliedAt: Date | null;
  createdAt: Date;
};

function playbookFrom(
  entry: typeof errorCatalogueTable.$inferSelect | undefined,
): Playbook {
  return entry
    ? {
        code: entry.code,
        category: entry.category,
        cause: entry.cause,
        fix: entry.fix,
        retriable: entry.retriable,
      }
    : null;
}

function escalationView(
  e: typeof escalationsTable.$inferSelect,
): EscalationView {
  return {
    id: e.id,
    reason: e.reason,
    errorCode: e.errorCode,
    status: e.status,
    context: e.context,
    operatorReply: e.operatorReply,
    repliedAt: e.repliedAt,
    createdAt: e.createdAt,
  };
}

// Pure view assembly for the batched lookup path below. One shape, one
// lookup implementation — the single-case handlers (claim/resolve) go through
// caseViews with a one-element array rather than keeping a parallel
// per-row-fetch variant that could drift.
function shapeCaseView(
  row: OperatorCase,
  deps: {
    firmName: string | null;
    clientName: string | null;
    invoiceNumber: string | null;
    playbook: Playbook;
    escalations: EscalationView[];
  },
) {
  return {
    id: row.id,
    firmId: row.firmId,
    firmName: deps.firmName,
    clientPartyId: row.clientPartyId,
    clientName: deps.clientName,
    invoiceId: row.invoiceId,
    invoiceNumber: deps.invoiceNumber,
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
    triage: row.triage,
    playbook: deps.playbook,
    escalations: deps.escalations,
  };
}

// Single case (claim/resolve responses): the batched path with one row.
async function caseView(row: OperatorCase) {
  const [view] = await caseViews([row]);
  return view;
}

// The list: resolve every lookup for the whole page in a fixed number of
// batched queries (not 5×N sequential ones — the operator queue is the
// hottest operator screen and grows with open cases).
async function caseViews(rows: OperatorCase[]) {
  if (rows.length === 0) return [];
  const uniq = (xs: (string | null)[]) => [
    ...new Set(xs.filter((x): x is string => x !== null)),
  ];
  const firmIds = uniq(rows.map((r) => r.firmId));
  const partyIds = uniq(rows.map((r) => r.clientPartyId));
  const invoiceIds = uniq(rows.map((r) => r.invoiceId));
  const codes = uniq(rows.map((r) => r.errorCode));

  const [firms, parties, invoices, entries, escalations] = await Promise.all([
    firmIds.length
      ? getDb()
          .select({ id: firmsTable.id, name: firmsTable.name })
          .from(firmsTable)
          .where(inArray(firmsTable.id, firmIds))
      : [],
    partyIds.length
      ? getDb()
          .select({ id: partiesTable.id, legalName: partiesTable.legalName })
          .from(partiesTable)
          .where(inArray(partiesTable.id, partyIds))
      : [],
    invoiceIds.length
      ? getDb()
          .select({
            id: invoicesTable.id,
            invoiceNumber: invoicesTable.invoiceNumber,
          })
          .from(invoicesTable)
          .where(inArray(invoicesTable.id, invoiceIds))
      : [],
    codes.length
      ? getDb()
          .select()
          .from(errorCatalogueTable)
          .where(inArray(errorCatalogueTable.code, codes))
      : [],
    // SME-06: the operator sees what the client already reported and tried —
    // escalations ride along with the case, no re-entry.
    invoiceIds.length
      ? getDb()
          .select()
          .from(escalationsTable)
          .where(inArray(escalationsTable.invoiceId, invoiceIds))
          .orderBy(desc(escalationsTable.createdAt))
      : [],
  ]);

  const firmName = new Map(firms.map((f) => [f.id, f.name]));
  const clientName = new Map(parties.map((p) => [p.id, p.legalName]));
  const invoiceNumber = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
  const playbookByCode = new Map(entries.map((e) => [e.code, playbookFrom(e)]));
  // Grouped by invoice, preserving the createdAt-desc order from the query.
  const escByInvoice = new Map<string, EscalationView[]>();
  for (const e of escalations) {
    const list = escByInvoice.get(e.invoiceId) ?? [];
    list.push(escalationView(e));
    escByInvoice.set(e.invoiceId, list);
  }

  return rows.map((row) =>
    shapeCaseView(row, {
      firmName: row.firmId ? (firmName.get(row.firmId) ?? null) : null,
      clientName: row.clientPartyId
        ? (clientName.get(row.clientPartyId) ?? null)
        : null,
      invoiceNumber: row.invoiceId
        ? (invoiceNumber.get(row.invoiceId) ?? null)
        : null,
      playbook: row.errorCode
        ? (playbookByCode.get(row.errorCode) ?? null)
        : null,
      escalations: row.invoiceId ? (escByInvoice.get(row.invoiceId) ?? []) : [],
    }),
  );
}

router.get("/operator/cases", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const query = parseOrThrow(ListOperatorCasesQueryParams, req.query);
  const rows = await getDb()
    .select()
    .from(operatorCasesTable)
    .where(
      query.status ? eq(operatorCasesTable.status, query.status) : undefined,
    )
    .orderBy(desc(operatorCasesTable.openedAt));
  rows.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  res.json(ListOperatorCasesResponse.parse(await caseViews(rows)));
});

router.get("/operator/cases/stats", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  // One aggregate pass instead of loading every case row into JS.
  // count(DISTINCT) ignores NULL client ids (the old .filter(Boolean) Set);
  // the FILTERed avg is NULL when no resolved row carries handle_seconds.
  const [stats] = await getDb()
    .select({
      openCount: sql<number>`(count(*) filter (where ${operatorCasesTable.status} = 'open'))::int`,
      inProgressCount: sql<number>`(count(*) filter (where ${operatorCasesTable.status} = 'in_progress'))::int`,
      resolvedCount: sql<number>`(count(*) filter (where ${operatorCasesTable.status} = 'resolved'))::int`,
      clientsServed: sql<number>`(count(distinct ${operatorCasesTable.clientPartyId}))::int`,
      avgHandleSeconds: sql<
        number | null
      >`(round(avg(${operatorCasesTable.handleSeconds}) filter (where ${operatorCasesTable.status} = 'resolved' and ${operatorCasesTable.handleSeconds} is not null)))::int`,
    })
    .from(operatorCasesTable);
  res.json(GetOperatorQueueStatsResponse.parse(stats));
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
  const params = parseOrThrow(ClaimOperatorCaseParams, req.params);
  const existing = await loadCase(params.id);
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
  const params = parseOrThrow(ResolveOperatorCaseParams, req.params);
  const parsed = parseOrThrow(ResolveOperatorCaseBody, req.body);
  const existing = await loadCase(params.id);
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
      resolutionCode: parsed.resolutionCode,
      resolutionNote: parsed.note ?? null,
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

// Drafted escalation replies (exhaust idea #5). The draft is grounded in the
// catalogue + real attempt history and NEVER sent by the model — the operator
// edits and presses send, and the send route is the only writer of
// operator_reply. Platform-funded, like the other operator drafting tools.
router.post("/escalations/:id/reply-draft", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const params = parseOrThrow(DraftEscalationReplyParams, req.params);
  // Template posture end to end: an unconfigured provider integration must
  // yield the deterministic template, not a 500 (same guard as the
  // narrative and reconcile-assist routes).
  const gateway = await gatewayOrNull();
  const draft = await draftEscalationReply(params.id, gateway);
  res.json(DraftEscalationReplyResponse.parse(draft));
});

router.post("/escalations/:id/reply", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const params = parseOrThrow(ReplyToEscalationParams, req.params);
  const body = parseOrThrow(ReplyToEscalationBody, req.body);
  const updated = await sendEscalationReply(
    params.id,
    body.reply,
    req.principal.userId,
  );
  res.json(ReplyToEscalationResponse.parse(updated));
});

export default router;
