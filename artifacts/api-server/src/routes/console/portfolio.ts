import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  partiesTable,
  engagementsTable,
  usersTable,
  membershipsTable,
  onboardingProspectsTable,
  clientAssignmentsTable,
  type Invoice,
} from "@workspace/db";
import {
  GetPortfolioResponse,
  GetClientPortfolioParams,
  GetClientPortfolioResponse,
  GetClientAssignmentsParams,
  GetClientAssignmentsResponse,
  ReplaceClientAssignmentsParams,
  ReplaceClientAssignmentsBody,
  ReplaceClientAssignmentsResponse,
  ListFirmTeamResponse,
  ListPipelineResponse,
  CreateProspectBody,
  CreateProspectResponse,
  UpdateProspectParams,
  UpdateProspectBody,
  UpdateProspectResponse,
  GetRejectionPatternsResponse,
  GetFirmComplianceCalendarResponse,
  GetFirmReceivablesResponse,
  GetComplianceScorecardResponse,
  GetClerkAdoptionReportResponse,
  GetOperatorBriefResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  firmScope,
  ROLE_CAPABILITIES,
} from "../../modules/auth/rbac";
import { appendAudit } from "../../modules/audit/audit";
import { DomainError } from "../../modules/errors";
import { partyNamesById } from "../../modules/party/party";
import { computeRejectionPatterns } from "../../modules/desk/rejection-patterns";
import { computeAdoptionReport } from "../../modules/clerk/adoption";
import { computeOperatorBrief } from "../../modules/desk/daily-brief";
import { computeComplianceCalendar } from "../../modules/invoice/compliance-calendar";
import { getFirmReceivables } from "../../modules/invoice/receivables";
import { computeComplianceScorecard } from "../../modules/invoice/compliance-scorecard";
import {
  SUBMISSION_WINDOW_DAYS,
  daysUntil,
  isStamped,
  isUnsubmitted,
  penaltyRisk as computePenaltyRisk,
  submissionDeadline,
} from "../../modules/invoice/compliance-window";
import { PRIORITY_RANK } from "./shared";

const router: IRouter = Router();

// The firm a console request is scoped to: firmScope, imported from rbac
// (the ONE definition — vat-position.ts shares it).

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
  // D12: filled by the portfolio list only.
  assignedUserIds?: string[];
};

// The one "overdue submission" nextDeadline literal, shared by the JS fold
// (computeClientRisk) and the SQL-aggregate view (riskFromAggregate) so the
// two read paths cannot drift. invoiceId is string | null because the fold's
// earliest-overdue pair narrows together but TS cannot see it.
function overdueSubmissionDeadline(
  clientPartyId: string,
  invoiceId: string | null,
  dueDate: Date,
): NonNullable<ClientRisk["nextDeadline"]> {
  return {
    id: `submit-${invoiceId}`,
    clientPartyId,
    kind: "penalty_watch",
    title: "Overdue invoice submission",
    description:
      "Past the submission window — may attract penalties until stamped.",
    dueDate,
    status: "overdue",
    severity: "critical",
    invoiceId,
  };
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
      const submitBy = submissionDeadline(inv.issueDate);
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

  const penaltyRisk = computePenaltyRisk(overdueCount, failedCount, dueSoon);

  const nextDeadline = earliestOverdue
    ? overdueSubmissionDeadline(
        clientPartyId,
        earliestOverdueInvoice,
        earliestOverdue,
      )
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

// Per-staff client assignment (D12): userIds per client for one firm, one
// query. The register narrows default views only — never access.
async function loadFirmAssignments(
  firmId: string,
): Promise<Map<string, string[]>> {
  const rows = await getDb()
    .select({
      clientPartyId: clientAssignmentsTable.clientPartyId,
      userId: clientAssignmentsTable.userId,
    })
    .from(clientAssignmentsTable)
    .where(eq(clientAssignmentsTable.firmId, firmId));
  const byClient = new Map<string, string[]>();
  for (const r of rows) {
    const list = byClient.get(r.clientPartyId) ?? [];
    list.push(r.userId);
    byClient.set(r.clientPartyId, list);
  }
  return byClient;
}

async function assertFirmEngagesClient(
  firmId: string,
  clientPartyId: string,
): Promise<void> {
  const [row] = await getDb()
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, clientPartyId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new DomainError("NOT_FOUND", "Client not found in your firm", 404);
  }
}

async function clientAssignees(firmId: string, clientPartyId: string) {
  const rows = await getDb()
    .select({
      userId: clientAssignmentsTable.userId,
      assignedAt: clientAssignmentsTable.createdAt,
      fullName: usersTable.fullName,
      email: usersTable.email,
      role: membershipsTable.role,
    })
    .from(clientAssignmentsTable)
    .innerJoin(usersTable, eq(clientAssignmentsTable.userId, usersTable.id))
    .innerJoin(
      membershipsTable,
      and(
        eq(membershipsTable.userId, clientAssignmentsTable.userId),
        eq(membershipsTable.firmId, clientAssignmentsTable.firmId),
      ),
    )
    .where(
      and(
        eq(clientAssignmentsTable.firmId, firmId),
        eq(clientAssignmentsTable.clientPartyId, clientPartyId),
      ),
    )
    .orderBy(clientAssignmentsTable.createdAt);
  return {
    clientPartyId,
    assignees: rows.map((r) => ({
      userId: r.userId,
      fullName: r.fullName,
      email: r.email,
      role: r.role,
      assignedAt: r.assignedAt,
    })),
  };
}

router.get(
  "/console/clients/:id/assignments",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "console.portfolio.read");
    const params = parseOrThrow(GetClientAssignmentsParams, req.params);
    const firmId = firmScope(req.principal);
    await assertFirmEngagesClient(firmId, params.id);
    res.json(
      GetClientAssignmentsResponse.parse(
        await clientAssignees(firmId, params.id),
      ),
    );
  },
);

// Replace the assignee set. Firm-admin only (client.assign); every id must be
// a firm admin or staff member of THIS firm; each add and removal is its own
// audit event so the register's history is on the chain.
router.put(
  "/console/clients/:id/assignments",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "client.assign");
    const params = parseOrThrow(ReplaceClientAssignmentsParams, req.params);
    const body = parseOrThrow(ReplaceClientAssignmentsBody, req.body);
    const firmId = firmScope(req.principal);
    await assertFirmEngagesClient(firmId, params.id);
    const wanted = [...new Set(body.userIds)];
    if (wanted.length > 0) {
      const members = await getDb()
        .select({ userId: membershipsTable.userId })
        .from(membershipsTable)
        .where(
          and(
            eq(membershipsTable.firmId, firmId),
            inArray(membershipsTable.userId, wanted),
            inArray(membershipsTable.role, ["firm_admin", "firm_staff"]),
          ),
        );
      const memberIds = new Set(members.map((m) => m.userId));
      const stranger = wanted.find((id) => !memberIds.has(id));
      if (stranger) {
        throw new DomainError(
          "INVALID_ASSIGNEE",
          "Every assignee must be a firm admin or staff member of your firm",
          400,
        );
      }
    }
    const current = new Set(
      (await getDb()
        .select({ userId: clientAssignmentsTable.userId })
        .from(clientAssignmentsTable)
        .where(
          and(
            eq(clientAssignmentsTable.firmId, firmId),
            eq(clientAssignmentsTable.clientPartyId, params.id),
          ),
        )).map((r) => r.userId),
    );
    const toAdd = wanted.filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !wanted.includes(id));
    if (toAdd.length > 0) {
      await getDb()
        .insert(clientAssignmentsTable)
        .values(
          toAdd.map((userId) => ({
            firmId,
            clientPartyId: params.id,
            userId,
            assignedBy: req.principal.userId,
          })),
        )
        .onConflictDoNothing();
    }
    if (toRemove.length > 0) {
      await getDb()
        .delete(clientAssignmentsTable)
        .where(
          and(
            eq(clientAssignmentsTable.firmId, firmId),
            eq(clientAssignmentsTable.clientPartyId, params.id),
            inArray(clientAssignmentsTable.userId, toRemove),
          ),
        );
    }
    for (const userId of toAdd) {
      await appendAudit({
        actorId: req.principal.userId,
        actorRole: req.principal.role,
        firmId,
        action: "client.assign",
        entityType: "client_assignment",
        entityId: params.id,
        after: { clientPartyId: params.id, userId },
      });
    }
    for (const userId of toRemove) {
      await appendAudit({
        actorId: req.principal.userId,
        actorRole: req.principal.role,
        firmId,
        action: "client.unassign",
        entityType: "client_assignment",
        entityId: params.id,
        before: { clientPartyId: params.id, userId },
      });
    }
    res.json(
      ReplaceClientAssignmentsResponse.parse(
        await clientAssignees(firmId, params.id),
      ),
    );
  },
);

// Receivables across the firm's whole book: who is owed (per client) and who
// owes (top debtors) — the advisor's chasing worklist, worst first.
router.get("/console/receivables", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const rollup = await getFirmReceivables(firmId);
  res.json(GetFirmReceivablesResponse.parse(rollup));
});

// Client compliance scorecard (round-19 idea #3): the cross-client posture
// league table — pure SQL over engaged clients, attention first, sample
// floors on every rate, posture-not-blame note. Same firm-rollup gate as
// the receivables above (client_users have no console.portfolio.read).
router.get("/console/compliance-scorecard", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const scorecard = await computeComplianceScorecard(firmId);
  res.json(GetComplianceScorecardResponse.parse(scorecard));
});

// Operator daily brief (round-12 idea #1): the desk's "what needs me first"
// in one deterministic summary — queues, stuck work, platform state,
// yesterday's throughput. Pure SQL, zero model calls, operator surface.
router.get("/console/operator-brief", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const brief = await computeOperatorBrief();
  res.json(GetOperatorBriefResponse.parse(brief));
});

// Clerk adoption & impact (round-10 idea #3): per-client capture volume,
// kept-rate and review turnaround from the firm's own cases — the renewal
// numbers. Pure SQL, zero model calls.
router.get("/console/clerk-adoption", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const report = await computeAdoptionReport(firmId);
  res.json(GetClerkAdoptionReportResponse.parse(report));
});

// One aggregate row per client, computed in Postgres. This route used to load
// every client's full invoice book into JS (one query per client) and fold it
// with computeClientRisk — O(clients × invoices) per dashboard view, the first
// thing to fall over as a firm's book grows. The SQL mirrors computeClientRisk
// exactly (same status buckets, same Lagos-midnight deadline instant as
// submissionDeadline, same tie-breaks), so the two read paths cannot disagree;
// /console/clients/:id keeps the JS fold since it needs the row list anyway.
type ClientRiskAggregate = {
  clientPartyId: string;
  totalInvoices: number;
  unsubmittedCount: number;
  unsubmittedValue: string;
  failedCount: number;
  pendingCount: number;
  stampedCount: number;
  overdueCount: number;
  dueSoon: boolean;
  earliestOverdueAt: Date | null;
  earliestOverdueId: string | null;
  failingInvoiceIds: string[];
};

async function loadClientRiskAggregates(
  firmId: string,
): Promise<Map<string, ClientRiskAggregate>> {
  const unsubmitted = sql`${invoicesTable.status} IN ('draft', 'validated')`;
  // submissionDeadline() as a SQL expression: Lagos midnight after the window.
  const deadline = sql`((${invoicesTable.issueDate}::date + ${sql.raw(
    String(SUBMISSION_WINDOW_DAYS),
  )} * interval '1 day')::timestamp AT TIME ZONE 'Africa/Lagos')`;
  const overdue = sql`${unsubmitted} AND ${deadline} < now()`;
  const rows = await getDb()
    .select({
      clientPartyId: invoicesTable.supplierPartyId,
      totalInvoices: sql<number>`count(*)::int`,
      unsubmittedCount: sql<number>`count(*) FILTER (WHERE ${unsubmitted})::int`,
      unsubmittedValue: sql<string>`coalesce(sum(${invoicesTable.grandTotal}) FILTER (WHERE ${unsubmitted}), 0)::text`,
      failedCount: sql<number>`count(*) FILTER (WHERE ${invoicesTable.status} = 'failed')::int`,
      pendingCount: sql<number>`count(*) FILTER (WHERE ${invoicesTable.status} = 'submitted')::int`,
      stampedCount: sql<number>`count(*) FILTER (WHERE ${invoicesTable.status} IN ('stamped', 'confirmed', 'settled'))::int`,
      overdueCount: sql<number>`count(*) FILTER (WHERE ${overdue})::int`,
      // Mirrors daysUntil(deadline, now) in [0, 3]: not yet due, under 4 days out.
      dueSoon: sql<boolean>`coalesce(bool_or(${unsubmitted} AND ${deadline} >= now() AND ${deadline} < now() + interval '4 days'), false)`,
      earliestOverdueAt: sql<Date | null>`min(${deadline}) FILTER (WHERE ${overdue})`,
      // computeClientRisk scans createdAt-DESC and keeps the strictly-earliest
      // deadline, so ties go to the most recently created invoice.
      earliestOverdueId: sql<
        string | null
      >`(array_agg(${invoicesTable.id} ORDER BY ${deadline} ASC, ${invoicesTable.createdAt} DESC) FILTER (WHERE ${overdue}))[1]`,
      failingInvoiceIds: sql<
        string[]
      >`coalesce(array_agg(${invoicesTable.id} ORDER BY ${invoicesTable.createdAt} DESC) FILTER (WHERE ${invoicesTable.status} = 'failed'), '{}')`,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.firmId, firmId))
    .groupBy(invoicesTable.supplierPartyId);
  return new Map(rows.map((r) => [r.clientPartyId, r]));
}

function riskFromAggregate(
  clientPartyId: string,
  legalName: string,
  agg: ClientRiskAggregate | undefined,
): ClientRisk {
  if (!agg) {
    return {
      clientPartyId,
      legalName,
      totalInvoices: 0,
      unsubmittedCount: 0,
      unsubmittedValue: "0.00",
      failedCount: 0,
      pendingCount: 0,
      stampedCount: 0,
      overdueCount: 0,
      penaltyRisk: "low",
      nextDeadline: null,
      failingInvoiceIds: [],
    };
  }
  const nextDeadline =
    agg.earliestOverdueAt && agg.earliestOverdueId
      ? overdueSubmissionDeadline(
          clientPartyId,
          agg.earliestOverdueId,
          agg.earliestOverdueAt,
        )
      : null;
  return {
    clientPartyId,
    legalName,
    totalInvoices: agg.totalInvoices,
    unsubmittedCount: agg.unsubmittedCount,
    unsubmittedValue: Number(agg.unsubmittedValue).toFixed(2),
    failedCount: agg.failedCount,
    pendingCount: agg.pendingCount,
    stampedCount: agg.stampedCount,
    overdueCount: agg.overdueCount,
    penaltyRisk: computePenaltyRisk(agg.overdueCount, agg.failedCount, agg.dueSoon),
    nextDeadline,
    failingInvoiceIds: agg.failingInvoiceIds,
  };
}

router.get("/console/portfolio", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const clients = await loadFirmClients(firmId);
  const aggregates = await loadClientRiskAggregates(firmId);
  const assignments = await loadFirmAssignments(firmId);
  const risks: ClientRisk[] = clients.map((client) => ({
    ...riskFromAggregate(client.id, client.legalName, aggregates.get(client.id)),
    // D12: who looks after this client; empty = unassigned (visible to all).
    assignedUserIds: assignments.get(client.id) ?? [],
  }));

  // Riskiest clients first so the partner triages top-down.
  risks.sort((a, b) => PRIORITY_RANK[a.penaltyRisk] - PRIORITY_RANK[b.penaltyRisk]);

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
  const params = parseOrThrow(GetClientPortfolioParams, req.params);
  const firmId = firmScope(req.principal);
  const [client] = await getDb()
    .select({ id: partiesTable.id, legalName: partiesTable.legalName })
    .from(engagementsTable)
    .innerJoin(partiesTable, eq(engagementsTable.clientPartyId, partiesTable.id))
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, params.id),
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

  const buyerName = await partyNamesById(invoices.map((i) => i.buyerPartyId));

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
  const parsed = parseOrThrow(CreateProspectBody, req.body);
  const firmId = firmScope(req.principal);
  const [row] = await getDb()
    .insert(onboardingProspectsTable)
    .values({
      firmId,
      name: parsed.name,
      contactEmail: parsed.contactEmail ?? null,
      stage: parsed.stage ?? "lead",
      estimatedMonthlyInvoices: parsed.estimatedMonthlyInvoices ?? 0,
      note: parsed.note ?? null,
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
  const params = parseOrThrow(UpdateProspectParams, req.params);
  const parsed = parseOrThrow(UpdateProspectBody, req.body);
  const firmId = firmScope(req.principal);
  const [existing] = await getDb()
    .select()
    .from(onboardingProspectsTable)
    .where(
      and(
        eq(onboardingProspectsTable.id, params.id),
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
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.contactEmail !== undefined
        ? { contactEmail: parsed.contactEmail }
        : {}),
      ...(parsed.stage !== undefined ? { stage: parsed.stage } : {}),
      ...(parsed.estimatedMonthlyInvoices !== undefined
        ? { estimatedMonthlyInvoices: parsed.estimatedMonthlyInvoices }
        : {}),
      ...(parsed.clientPartyId !== undefined
        ? { clientPartyId: parsed.clientPartyId }
        : {}),
      ...(parsed.note !== undefined ? { note: parsed.note } : {}),
    })
    .where(eq(onboardingProspectsTable.id, params.id))
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

// Rejection-pattern report (round-4 idea #3): the firm's recurring rejection
// causes over a trailing window, catalogue-grounded — pure SQL, zero model
// calls, nothing stored. The desk sees rejections one case at a time; this
// is the aggregate view that says "this firm hit the same code eleven times
// across four clients".
router.get("/rejection-patterns", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const report = await computeRejectionPatterns(firmId);
  res.json(GetRejectionPatternsResponse.parse(report));
});

// Firm-level compliance calendar (round-6 idea #5): the month-ahead view of
// the same statutory clocks each client's dashboard shows — same constants,
// same Lagos-calendar expressions, aggregated across the firm in one SQL
// pass. Deterministic, nothing stored.
router.get("/compliance-calendar", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const calendar = await computeComplianceCalendar(firmId);
  res.json(GetFirmComplianceCalendarResponse.parse(calendar));
});

export default router;
