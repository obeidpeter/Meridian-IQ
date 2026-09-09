import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  bankStatementsTable,
  confirmationsTable,
  engagementsTable,
  erpConnectionsTable,
  filingReturnsTable,
  firmsTable,
  getDb,
  invoicesTable,
  obligationsTable,
  partiesTable,
  usersTable,
  workItemsTable,
} from "@workspace/db";
import {
  GetWorkspaceTodayQueryParams,
  GetWorkspaceTodayResponse,
  SearchWorkspaceQueryParams,
  SearchWorkspaceResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  clientPartyScope,
  requireFirmScope,
  type Principal,
} from "../modules/auth/rbac";
import { hasConsentDecisions } from "../modules/consent/consent";
import { isFeatureEnabled } from "../modules/flags/flags";
import {
  firstInvoiceSetup,
  type SetupStep,
} from "../modules/workspace/onboarding";
import {
  addTodayCounts,
  datePrioritySql,
  dueDate,
  dueDateSql,
  dueDescription,
  emptyTodayCounts,
  priorityFor,
  sortToday,
  todayCountFields,
  workPrioritySql,
  type TodayCounts,
} from "../modules/workspace/today";

const router: IRouter = Router();
const clientNames = alias(partiesTable, "workspace_client_names");
const counterpartyNames = alias(partiesTable, "workspace_counterparty_names");
const assigneeNames = alias(usersTable, "workspace_assignee_names");

type TodayItem = {
  id: string;
  source: "work_item" | "invoice" | "filing" | "obligation";
  kind: string;
  title: string;
  description: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: string;
  dueAt: Date | null;
  href: string;
  clientPartyId: string | null;
  clientName: string | null;
  entityType: string | null;
  entityId: string | null;
};

function itemHref(
  role: string,
  source: TodayItem["source"],
  entityId: string,
  clientPartyId: string,
): string {
  if (source === "work_item") return "/work";
  if (role === "buyer_user") return `/invoices/${entityId}`;
  if (role === "client_user") {
    if (source === "invoice") return `/invoices/${entityId}`;
    if (source === "filing") return "/filings";
    return "/obligations";
  }
  const view = source === "invoice" ? "invoices" : "compliance";
  return `/clients/${clientPartyId}?view=${view}`;
}

async function firstRow<T>(promise: Promise<T[]>): Promise<boolean> {
  return (await promise).length > 0;
}

async function setupForFirm(
  principal: Principal,
  options: { canManageConnections: boolean },
): Promise<SetupStep[]> {
  const firmId = requireFirmScope(principal);
  const [invoiceSteps, hasConnection, hasWork, users] = await Promise.all([
    firstInvoiceSetup(principal),
    options.canManageConnections
      ? firstRow(
          getDb()
            .select({ id: erpConnectionsTable.id })
            .from(erpConnectionsTable)
            .where(eq(erpConnectionsTable.firmId, firmId))
            .limit(1),
        )
      : Promise.resolve(false),
    firstRow(
      getDb()
        .select({ id: workItemsTable.id })
        .from(workItemsTable)
        .where(eq(workItemsTable.firmId, firmId))
        .limit(1),
    ),
    getDb()
      .select({ totpEnabledAt: usersTable.totpEnabledAt })
      .from(usersTable)
      .where(eq(usersTable.id, principal.userId))
      .limit(1),
  ]);
  const user = users[0];
  return [
    ...invoiceSteps,
    ...(options.canManageConnections
      ? [
          {
            id: "first_connection",
            label: "Set up an accounting connection",
            description:
              "Save the connection configuration. Successful provider verification is checked separately.",
            complete: hasConnection,
            href: "/integrations",
          },
        ]
      : []),
    {
      id: "first_work_item",
      label: "Coordinate the first task",
      description: "Assign an owner and due date for client work.",
      complete: hasWork,
      href: "/work?action=new",
    },
    {
      id: "two_factor",
      label: "Protect the account with two-factor authentication",
      description: "Require a time-based code in addition to the password.",
      complete: Boolean(user?.totpEnabledAt),
      href: "/login",
    },
  ];
}

async function setupForClient(
  principal: Principal,
  clientPartyId: string,
  options: { reconciliationEnabled: boolean },
): Promise<SetupStep[]> {
  const firmId = requireFirmScope(principal);
  const [invoiceSteps, hasStatement, users, consentComplete] =
    await Promise.all([
      firstInvoiceSetup(principal),
      options.reconciliationEnabled
        ? firstRow(
            getDb()
              .select({ id: bankStatementsTable.id })
              .from(bankStatementsTable)
              .where(
                and(
                  eq(bankStatementsTable.firmId, firmId),
                  eq(bankStatementsTable.clientPartyId, clientPartyId),
                ),
              )
              .limit(1),
          )
        : Promise.resolve(false),
      getDb()
        .select({ totpEnabledAt: usersTable.totpEnabledAt })
        .from(usersTable)
        .where(eq(usersTable.id, principal.userId))
        .limit(1),
      hasConsentDecisions(clientPartyId, [1, 2]),
    ]);
  const user = users[0];
  return [
    {
      id: "consent",
      label: "Choose data permissions",
      description: "Review how invoicing and reconciliation data may be used.",
      complete: consentComplete,
      href: "/consent",
    },
    ...invoiceSteps,
    ...(options.reconciliationEnabled
      ? [
          {
            id: "first_statement",
            label: "Add a bank statement",
            description: "Match payments to invoices from one reliable record.",
            complete: hasStatement,
            href: "/reconciliation",
          },
        ]
      : []),
    {
      id: "two_factor",
      label: "Protect the account with two-factor authentication",
      description: "Require a time-based code in addition to the password.",
      complete: Boolean(user?.totpEnabledAt),
      href: "/login",
    },
  ];
}

async function firmToday(
  role: string,
  firmId: string,
  clientPartyId: string | null,
  limit: number,
  statutoryEnabled: boolean,
  now: Date,
): Promise<{ items: TodayItem[]; summary: TodayCounts }> {
  const invoiceConditions = [
    eq(invoicesTable.firmId, firmId),
    inArray(invoicesTable.status, [
      "draft",
      "validated",
      "submitted",
      "failed",
    ]),
    ...(clientPartyId
      ? [eq(invoicesTable.supplierPartyId, clientPartyId)]
      : []),
  ];
  const filingConditions = [
    eq(filingReturnsTable.firmId, firmId),
    ne(filingReturnsTable.status, "filed"),
    ...(clientPartyId
      ? [eq(filingReturnsTable.clientPartyId, clientPartyId)]
      : []),
  ];
  const obligationConditions = [
    eq(obligationsTable.firmId, firmId),
    ne(obligationsTable.status, "closed"),
    ...(clientPartyId
      ? [eq(obligationsTable.clientPartyId, clientPartyId)]
      : []),
  ];
  const invoiceDue = dueDateSql(invoicesTable.dueDate);
  const filingDue = dueDateSql(filingReturnsTable.dueDate);
  const obligationDue = dueDateSql(obligationsTable.responseDueDate);
  const invoiceRank = datePrioritySql(invoiceDue, now, {
    failed: eq(invoicesTable.status, "failed"),
  });
  const filingRank = datePrioritySql(filingDue, now);
  const obligationRank = datePrioritySql(obligationDue, now);
  const manualRank = workPrioritySql(workItemsTable.priority);
  const manualDue = sql`date_trunc('milliseconds', ${workItemsTable.dueAt})`;
  // Top K from each source suffices for global top K only when SQL and the
  // final merge share priority, due date and ID ordering before every limit.
  const [manual, invoices, filings, obligations] = await Promise.all([
    getDb()
      .select({
        id: workItemsTable.id,
        title: workItemsTable.title,
        description: workItemsTable.description,
        priority: workItemsTable.priority,
        status: workItemsTable.status,
        dueAt: workItemsTable.dueAt,
        href: workItemsTable.href,
        clientPartyId: workItemsTable.clientPartyId,
        clientName: clientNames.legalName,
        assignedToName: assigneeNames.fullName,
        entityType: workItemsTable.entityType,
        entityId: workItemsTable.entityId,
        ...todayCountFields(manualDue, manualRank, workItemsTable.status, now),
      })
      .from(workItemsTable)
      .leftJoin(clientNames, eq(clientNames.id, workItemsTable.clientPartyId))
      .leftJoin(assigneeNames, eq(assigneeNames.id, workItemsTable.assignedTo))
      .where(
        and(
          eq(workItemsTable.firmId, firmId),
          ne(workItemsTable.status, "done"),
          clientPartyId
            ? eq(workItemsTable.clientPartyId, clientPartyId)
            : undefined,
        ),
      )
      .orderBy(manualRank, sql`${manualDue} asc nulls last`, workItemsTable.id)
      .limit(limit),
    getDb()
      .select({
        id: invoicesTable.id,
        invoiceNumber: invoicesTable.invoiceNumber,
        status: invoicesTable.status,
        dueDate: invoicesTable.dueDate,
        clientPartyId: invoicesTable.supplierPartyId,
        clientName: clientNames.legalName,
        counterpartyName: counterpartyNames.legalName,
        ...todayCountFields(invoiceDue, invoiceRank, invoicesTable.status, now),
      })
      .from(invoicesTable)
      .innerJoin(clientNames, eq(clientNames.id, invoicesTable.supplierPartyId))
      .innerJoin(
        counterpartyNames,
        eq(counterpartyNames.id, invoicesTable.buyerPartyId),
      )
      .where(and(...invoiceConditions))
      .orderBy(invoiceRank, sql`${invoiceDue} asc nulls last`, invoicesTable.id)
      .limit(limit),
    statutoryEnabled
      ? getDb()
          .select({
            id: filingReturnsTable.id,
            taxType: filingReturnsTable.taxType,
            period: filingReturnsTable.period,
            status: filingReturnsTable.status,
            dueDate: filingReturnsTable.dueDate,
            clientPartyId: filingReturnsTable.clientPartyId,
            clientName: clientNames.legalName,
            ...todayCountFields(
              filingDue,
              filingRank,
              filingReturnsTable.status,
              now,
            ),
          })
          .from(filingReturnsTable)
          .innerJoin(
            clientNames,
            eq(clientNames.id, filingReturnsTable.clientPartyId),
          )
          .where(and(...filingConditions))
          .orderBy(
            filingRank,
            sql`${filingDue} asc nulls last`,
            filingReturnsTable.id,
          )
          .limit(limit)
      : Promise.resolve([]),
    statutoryEnabled
      ? getDb()
          .select({
            id: obligationsTable.id,
            noticeType: obligationsTable.noticeType,
            authority: obligationsTable.authority,
            reference: obligationsTable.reference,
            status: obligationsTable.status,
            dueDate: obligationsTable.responseDueDate,
            clientPartyId: obligationsTable.clientPartyId,
            clientName: clientNames.legalName,
            ...todayCountFields(
              obligationDue,
              obligationRank,
              obligationsTable.status,
              now,
            ),
          })
          .from(obligationsTable)
          .innerJoin(
            clientNames,
            eq(clientNames.id, obligationsTable.clientPartyId),
          )
          .where(and(...obligationConditions))
          .orderBy(
            obligationRank,
            sql`${obligationDue} asc nulls last`,
            obligationsTable.id,
          )
          .limit(limit)
      : Promise.resolve([]),
  ]);

  const items: TodayItem[] = manual.map((item) => ({
    id: item.id,
    source: "work_item",
    kind: "task",
    title: item.title,
    description:
      item.description ??
      (item.assignedToName
        ? `Assigned to ${item.assignedToName}`
        : "Unassigned task"),
    priority: item.priority,
    status: item.status,
    dueAt: item.dueAt,
    href: item.href ?? "/work",
    clientPartyId: item.clientPartyId,
    clientName: item.clientName,
    entityType: item.entityType,
    entityId: item.entityId,
  }));
  for (const invoice of invoices) {
    const due = dueDate(invoice.dueDate);
    items.push({
      id: `invoice:${invoice.id}`,
      source: "invoice",
      kind: "invoice",
      title: `${invoice.invoiceNumber} · ${invoice.counterpartyName}`,
      description:
        invoice.status === "failed"
          ? "Submission needs attention"
          : `${invoice.status} · ${dueDescription(due, now)}`,
      priority: invoice.status === "failed" ? "urgent" : priorityFor(due, now),
      status: invoice.status,
      dueAt: due,
      href: itemHref(role, "invoice", invoice.id, invoice.clientPartyId),
      clientPartyId: invoice.clientPartyId,
      clientName: invoice.clientName,
      entityType: "invoice",
      entityId: invoice.id,
    });
  }
  for (const filing of filings) {
    const due = dueDate(filing.dueDate);
    items.push({
      id: `filing:${filing.id}`,
      source: "filing",
      kind: "filing",
      title: `${filing.taxType.toUpperCase()} · ${filing.period}`,
      description: `${filing.clientName} · ${dueDescription(due, now)}`,
      priority: priorityFor(due, now),
      status: filing.status,
      dueAt: due,
      href: itemHref(role, "filing", filing.id, filing.clientPartyId),
      clientPartyId: filing.clientPartyId,
      clientName: filing.clientName,
      entityType: "filing_return",
      entityId: filing.id,
    });
  }
  for (const obligation of obligations) {
    const due = dueDate(obligation.dueDate);
    items.push({
      id: `obligation:${obligation.id}`,
      source: "obligation",
      kind: "notice",
      title: obligation.reference
        ? `${obligation.authority} · ${obligation.reference}`
        : `${obligation.authority} · ${obligation.noticeType}`,
      description: `${obligation.clientName} · ${dueDescription(due, now)}`,
      priority: priorityFor(due, now),
      status: obligation.status,
      dueAt: due,
      href: itemHref(
        role,
        "obligation",
        obligation.id,
        obligation.clientPartyId,
      ),
      clientPartyId: obligation.clientPartyId,
      clientName: obligation.clientName,
      entityType: "obligation",
      entityId: obligation.id,
    });
  }
  return {
    items: sortToday(items).slice(0, limit),
    summary: addTodayCounts([
      manual[0],
      invoices[0],
      filings[0],
      obligations[0],
    ]),
  };
}

async function buyerToday(buyerPartyId: string, limit: number, now: Date) {
  const suppliers = alias(partiesTable, "workspace_buyer_suppliers");
  const due = dueDateSql(invoicesTable.dueDate);
  const rank = datePrioritySql(due, now, {
    failed: eq(invoicesTable.status, "failed"),
    awaitingConfirmation: eq(invoicesTable.status, "stamped"),
  });
  const invoices = await getDb()
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      supplierPartyId: invoicesTable.supplierPartyId,
      supplierName: suppliers.legalName,
      status: invoicesTable.status,
      dueDate: invoicesTable.dueDate,
      ...todayCountFields(due, rank, invoicesTable.status, now),
      reviewed:
        sql<number>`count(*) filter (where ${invoicesTable.status} = 'confirmed') over ()`.mapWith(
          Number,
        ),
    })
    .from(invoicesTable)
    .innerJoin(suppliers, eq(suppliers.id, invoicesTable.supplierPartyId))
    .where(
      and(
        eq(invoicesTable.buyerPartyId, buyerPartyId),
        inArray(invoicesTable.status, ["stamped", "confirmed", "failed"]),
      ),
    )
    .orderBy(rank, sql`${due} asc nulls last`, invoicesTable.id)
    .limit(limit);
  const items = sortToday(
    invoices.map((invoice): TodayItem => {
      const due = dueDate(invoice.dueDate);
      return {
        id: `invoice:${invoice.id}`,
        source: "invoice",
        kind: "confirmation",
        title: `${invoice.invoiceNumber} · ${invoice.supplierName}`,
        description:
          invoice.status === "stamped"
            ? "Awaiting your confirmation"
            : `${invoice.status} · ${dueDescription(due, now)}`,
        priority:
          invoice.status === "failed" || priorityFor(due, now) === "urgent"
            ? "urgent"
            : invoice.status === "stamped"
              ? "high"
              : priorityFor(due, now),
        status: invoice.status,
        dueAt: due,
        href: `/invoices/${invoice.id}`,
        clientPartyId: invoice.supplierPartyId,
        clientName: invoice.supplierName,
        entityType: "invoice",
        entityId: invoice.id,
      };
    }),
  ).slice(0, limit);
  // A response may have moved the invoice out of today's queue (e.g. settled).
  // Read recorded buyer responses independently, never infer a click from rows.
  const hasResponse = await firstRow(
    getDb()
      .select({ id: confirmationsTable.id })
      .from(confirmationsTable)
      .innerJoin(
        invoicesTable,
        eq(invoicesTable.id, confirmationsTable.invoiceId),
      )
      .where(
        and(
          eq(confirmationsTable.buyerPartyId, buyerPartyId),
          eq(invoicesTable.buyerPartyId, buyerPartyId),
          inArray(confirmationsTable.state, [
            "confirmed",
            "queried",
            "rejected",
          ]),
        ),
      )
      .limit(1),
  );
  return {
    items,
    summary: addTodayCounts([invoices[0]]),
    hasInvoices: (invoices[0]?.total ?? 0) > 0 || hasResponse,
    hasReviewed: (invoices[0]?.reviewed ?? 0) > 0 || hasResponse,
  };
}

router.get("/workspace/today", async (req, res): Promise<void> => {
  const now = new Date();
  const query = parseOrThrow(GetWorkspaceTodayQueryParams, req.query);
  const { role } = req.principal;
  let items: TodayItem[] = [];
  let setup: SetupStep[] = [];
  let summary = emptyTodayCounts();
  if (["firm_admin", "firm_staff", "client_user"].includes(role)) {
    const firmId = requireFirmScope(req.principal);
    const clientId = clientPartyScope(req.principal);
    const [statutoryEnabled, reconciliationEnabled, erpEnabled] =
      await Promise.all([
        isFeatureEnabled("statutory_desks", firmId),
        isFeatureEnabled("reconciliation", firmId),
        role === "firm_admin"
          ? isFeatureEnabled("erp_connectors", firmId)
          : Promise.resolve(false),
      ]);
    const today = await firmToday(
      role,
      firmId,
      clientId,
      query.limit,
      statutoryEnabled,
      now,
    );
    items = today.items;
    summary = today.summary;
    setup = clientId
      ? await setupForClient(req.principal, clientId, {
          reconciliationEnabled,
        })
      : await setupForFirm(req.principal, {
          canManageConnections: erpEnabled,
        });
  } else if (role === "buyer_user" && req.principal.buyerPartyId) {
    const today = await buyerToday(
      req.principal.buyerPartyId,
      query.limit,
      now,
    );
    items = today.items;
    summary = today.summary;
    setup = [
      {
        id: "review_queue",
        label: "Receive the first invoice",
        description:
          "An invoice or recorded response is available for this buyer.",
        complete: today.hasInvoices,
        href: "/confirmations",
      },
      {
        id: "first_confirmation",
        label: "Complete the first confirmation",
        description: "Confirm or dispute an invoice with a recorded reason.",
        complete: today.hasReviewed,
        href: "/confirmations",
      },
    ];
  } else if (role === "operator") {
    setup = [
      {
        id: "activation",
        label: "Review pilot activation",
        description: "Check adoption, provider readiness and unresolved cases.",
        complete: false,
        href: "/control-centre/activation",
      },
    ];
  }
  const completeSteps = setup.filter((step) => step.complete).length;
  res.json(
    GetWorkspaceTodayResponse.parse({
      role,
      generatedAt: now,
      summary: {
        ...summary,
        completedSetupSteps: completeSteps,
        totalSetupSteps: setup.length,
      },
      items,
      setup,
    }),
  );
});

function patternFor(raw: string): string {
  return `%${raw.trim().replace(/[\\%_]/g, "\\$&")}%`;
}

router.get("/workspace/search", async (req, res): Promise<void> => {
  const query = parseOrThrow(SearchWorkspaceQueryParams, req.query);
  const pattern = patternFor(query.q);
  const result: Array<{
    id: string;
    kind:
      | "client"
      | "supplier"
      | "invoice"
      | "filing"
      | "obligation"
      | "work_item"
      | "firm";
    label: string;
    description: string;
    group: string;
    href: string;
  }> = [];
  const { role } = req.principal;
  if (["firm_admin", "firm_staff", "client_user"].includes(role)) {
    const firmId = requireFirmScope(req.principal);
    const clientId = clientPartyScope(req.principal);
    const statutoryEnabled = await isFeatureEnabled("statutory_desks", firmId);
    const buyers = alias(partiesTable, "workspace_search_buyers");
    const [clients, invoiceRows, filingRows, obligationRows, workRows] =
      await Promise.all([
        getDb()
          .selectDistinct({
            id: partiesTable.id,
            name: partiesTable.legalName,
            tin: partiesTable.tin,
          })
          .from(engagementsTable)
          .innerJoin(
            partiesTable,
            eq(partiesTable.id, engagementsTable.clientPartyId),
          )
          .where(
            and(
              eq(engagementsTable.firmId, firmId),
              clientId
                ? eq(engagementsTable.clientPartyId, clientId)
                : undefined,
              or(
                ilike(partiesTable.legalName, pattern),
                ilike(partiesTable.tin, pattern),
              ),
            ),
          )
          .limit(query.limit),
        getDb()
          .select({
            id: invoicesTable.id,
            number: invoicesTable.invoiceNumber,
            status: invoicesTable.status,
            clientId: invoicesTable.supplierPartyId,
            buyerName: buyers.legalName,
          })
          .from(invoicesTable)
          .innerJoin(buyers, eq(buyers.id, invoicesTable.buyerPartyId))
          .where(
            and(
              eq(invoicesTable.firmId, firmId),
              clientId
                ? eq(invoicesTable.supplierPartyId, clientId)
                : undefined,
              or(
                ilike(invoicesTable.invoiceNumber, pattern),
                ilike(buyers.legalName, pattern),
              ),
            ),
          )
          .orderBy(desc(invoicesTable.updatedAt))
          .limit(query.limit),
        statutoryEnabled
          ? getDb()
              .select({
                id: filingReturnsTable.id,
                taxType: filingReturnsTable.taxType,
                period: filingReturnsTable.period,
                status: filingReturnsTable.status,
                clientId: filingReturnsTable.clientPartyId,
              })
              .from(filingReturnsTable)
              .where(
                and(
                  eq(filingReturnsTable.firmId, firmId),
                  clientId
                    ? eq(filingReturnsTable.clientPartyId, clientId)
                    : undefined,
                  or(
                    ilike(filingReturnsTable.taxType, pattern),
                    ilike(filingReturnsTable.period, pattern),
                    ilike(filingReturnsTable.filedReference, pattern),
                  ),
                ),
              )
              .limit(query.limit)
          : Promise.resolve([]),
        statutoryEnabled
          ? getDb()
              .select({
                id: obligationsTable.id,
                authority: obligationsTable.authority,
                reference: obligationsTable.reference,
                noticeType: obligationsTable.noticeType,
                status: obligationsTable.status,
                clientId: obligationsTable.clientPartyId,
              })
              .from(obligationsTable)
              .where(
                and(
                  eq(obligationsTable.firmId, firmId),
                  clientId
                    ? eq(obligationsTable.clientPartyId, clientId)
                    : undefined,
                  or(
                    ilike(obligationsTable.reference, pattern),
                    ilike(obligationsTable.authority, pattern),
                    ilike(obligationsTable.noticeType, pattern),
                  ),
                ),
              )
              .limit(query.limit)
          : Promise.resolve([]),
        getDb()
          .select({
            id: workItemsTable.id,
            title: workItemsTable.title,
            description: workItemsTable.description,
            status: workItemsTable.status,
            href: workItemsTable.href,
          })
          .from(workItemsTable)
          .where(
            and(
              eq(workItemsTable.firmId, firmId),
              clientId ? eq(workItemsTable.clientPartyId, clientId) : undefined,
              or(
                ilike(workItemsTable.title, pattern),
                ilike(workItemsTable.description, pattern),
              ),
            ),
          )
          .orderBy(desc(workItemsTable.updatedAt))
          .limit(query.limit),
      ]);
    for (const client of clients) {
      result.push({
        id: `client:${client.id}`,
        kind: "client",
        label: client.name,
        description: client.tin ? `TIN ${client.tin}` : "Client business",
        group: "Clients",
        href: role === "client_user" ? "/" : `/clients/${client.id}`,
      });
    }
    for (const invoice of invoiceRows) {
      result.push({
        id: `invoice:${invoice.id}`,
        kind: "invoice",
        label: invoice.number,
        description: `${invoice.buyerName} · ${invoice.status}`,
        group: "Invoices",
        href: itemHref(role, "invoice", invoice.id, invoice.clientId),
      });
    }
    for (const filing of filingRows) {
      result.push({
        id: `filing:${filing.id}`,
        kind: "filing",
        label: `${filing.taxType.toUpperCase()} · ${filing.period}`,
        description: `${filing.status} filing`,
        group: "Compliance",
        href: itemHref(role, "filing", filing.id, filing.clientId),
      });
    }
    for (const obligation of obligationRows) {
      result.push({
        id: `obligation:${obligation.id}`,
        kind: "obligation",
        label: obligation.reference ?? obligation.noticeType,
        description: `${obligation.authority} · ${obligation.status}`,
        group: "Compliance",
        href: itemHref(role, "obligation", obligation.id, obligation.clientId),
      });
    }
    for (const work of workRows) {
      result.push({
        id: `work:${work.id}`,
        kind: "work_item",
        label: work.title,
        description: work.description ?? work.status,
        group: "Team work",
        href: work.href ?? "/work",
      });
    }
  } else if (role === "buyer_user" && req.principal.buyerPartyId) {
    const suppliers = alias(partiesTable, "workspace_search_suppliers");
    const rows = await getDb()
      .select({
        id: invoicesTable.id,
        number: invoicesTable.invoiceNumber,
        status: invoicesTable.status,
        supplierId: invoicesTable.supplierPartyId,
        supplierName: suppliers.legalName,
      })
      .from(invoicesTable)
      .innerJoin(suppliers, eq(suppliers.id, invoicesTable.supplierPartyId))
      .where(
        and(
          eq(invoicesTable.buyerPartyId, req.principal.buyerPartyId),
          or(
            ilike(invoicesTable.invoiceNumber, pattern),
            ilike(suppliers.legalName, pattern),
          ),
        ),
      )
      .orderBy(desc(invoicesTable.updatedAt))
      .limit(query.limit);
    for (const invoice of rows) {
      result.push({
        id: `invoice:${invoice.id}`,
        kind: "invoice",
        label: invoice.number,
        description: `${invoice.supplierName} · ${invoice.status}`,
        group: "Invoices",
        href: `/invoices/${invoice.id}`,
      });
    }
  } else if (["operator", "auditor"].includes(role)) {
    const rows = await getDb()
      .select({ id: firmsTable.id, name: firmsTable.name })
      .from(firmsTable)
      .where(ilike(firmsTable.name, pattern))
      .orderBy(firmsTable.name)
      .limit(query.limit);
    for (const firm of rows) {
      result.push({
        id: `firm:${firm.id}`,
        kind: "firm",
        label: firm.name,
        description: "Valo workspace",
        group: "Firms",
        href: role === "operator" ? "/control-centre/activation" : "/audit",
      });
    }
  }
  res.json(SearchWorkspaceResponse.parse(result.slice(0, query.limit)));
});

export default router;
