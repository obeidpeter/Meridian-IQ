import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

type Priority = "low" | "medium" | "high";
type ItemKind =
  | "operator_case"
  | "filing"
  | "obligation"
  | "buyer_confirmation";

interface RawOperationItem {
  entity_id: string;
  kind: ItemKind;
  title: string;
  firm_name: string | null;
  client_party_id: string | null;
  client_name: string | null;
  priority: Priority;
  status: string;
  due_at: Date | string;
  created_at: Date | string;
  detail: string;
  unassigned: boolean;
}

export function classifySla(
  dueAt: Date,
  now = new Date(),
): "healthy" | "due_soon" | "overdue" {
  const remainingHours = (dueAt.getTime() - now.getTime()) / 3_600_000;
  if (remainingHours < 0) return "overdue";
  if (remainingHours <= 72) return "due_soon";
  return "healthy";
}

function actionHref(item: RawOperationItem): string {
  if (item.kind === "operator_case") return "/operator-queue";
  if (item.kind === "filing") return "/filing-desk";
  if (item.kind === "buyer_confirmation") return "/control-centre/buyers";
  return "/audit";
}

const PRIORITY_RANK: Record<Priority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export async function getComplianceOperationsWorkspace() {
  const result = await getDb().execute(sql`
    WITH latest_confirmation AS (
      SELECT DISTINCT ON (invoice_id)
        id,
        invoice_id,
        state,
        created_at
      FROM confirmations
      ORDER BY invoice_id, created_at DESC, id DESC
    )
    SELECT
      operator_case.id::text AS entity_id,
      'operator_case'::text AS kind,
      operator_case.title,
      firm.name AS firm_name,
      operator_case.client_party_id::text,
      client.legal_name AS client_name,
      operator_case.priority::text,
      operator_case.status::text,
      operator_case.opened_at + CASE operator_case.priority
        WHEN 'high' THEN interval '4 hours'
        WHEN 'medium' THEN interval '24 hours'
        ELSE interval '72 hours'
      END AS due_at,
      operator_case.opened_at AS created_at,
      coalesce(operator_case.error_code, 'Managed Desk exception') AS detail,
      (operator_case.assigned_operator_id IS NULL) AS unassigned
    FROM operator_cases operator_case
    JOIN firms firm ON firm.id = operator_case.firm_id
    LEFT JOIN parties client ON client.id = operator_case.client_party_id
    WHERE operator_case.status <> 'resolved'

    UNION ALL

    SELECT
      filing.id::text,
      'filing'::text,
      upper(filing.tax_type) || ' return / ' || filing.period,
      firm.name,
      filing.client_party_id::text,
      client.legal_name,
      CASE
        WHEN filing.due_date < current_date THEN 'high'
        WHEN filing.due_date <= current_date + 7 THEN 'medium'
        ELSE 'low'
      END,
      filing.status::text,
      (filing.due_date::timestamp + interval '23 hours 59 minutes 59 seconds') AT TIME ZONE 'Africa/Lagos',
      filing.created_at,
      'Human filing evidence is still required'::text,
      false
    FROM filing_returns filing
    JOIN firms firm ON firm.id = filing.firm_id
    JOIN parties client ON client.id = filing.client_party_id
    WHERE filing.status <> 'filed'
      AND filing.due_date <= current_date + 30

    UNION ALL

    SELECT
      obligation.id::text,
      'obligation'::text,
      obligation.authority || ' / ' || replace(obligation.notice_type, '_', ' '),
      firm.name,
      obligation.client_party_id::text,
      client.legal_name,
      CASE
        WHEN obligation.response_due_date < current_date THEN 'high'
        WHEN obligation.response_due_date <= current_date + 7 THEN 'medium'
        ELSE 'low'
      END,
      obligation.status::text,
      (obligation.response_due_date::timestamp + interval '23 hours 59 minutes 59 seconds') AT TIME ZONE 'Africa/Lagos',
      obligation.created_at,
      coalesce(obligation.reference, obligation.tax_type, 'Authority response')::text,
      false
    FROM obligations obligation
    JOIN firms firm ON firm.id = obligation.firm_id
    JOIN parties client ON client.id = obligation.client_party_id
    WHERE obligation.status <> 'closed'
      AND obligation.response_due_date <= current_date + 30

    UNION ALL

    SELECT
      latest.id::text,
      'buyer_confirmation'::text,
      'Buyer confirmation / ' || invoice.invoice_number,
      firm.name,
      invoice.supplier_party_id::text,
      supplier.legal_name,
      CASE
        WHEN latest.created_at < now() - interval '3 days' THEN 'high'
        WHEN latest.created_at < now() - interval '2 days' THEN 'medium'
        ELSE 'low'
      END,
      'awaiting_buyer'::text,
      latest.created_at + interval '3 days',
      latest.created_at,
      'Awaiting ' || buyer.legal_name || ' response',
      false
    FROM latest_confirmation latest
    JOIN invoices invoice ON invoice.id = latest.invoice_id
    JOIN firms firm ON firm.id = invoice.firm_id
    JOIN parties supplier ON supplier.id = invoice.supplier_party_id
    JOIN parties buyer ON buyer.id = invoice.buyer_party_id
    WHERE latest.state = 'requested'
  `);

  const now = new Date();
  const rawItems = result.rows as unknown as RawOperationItem[];
  const allItems = rawItems
    .map((item) => {
      const dueAt = new Date(item.due_at);
      const createdAt = new Date(item.created_at);
      const slaState = classifySla(dueAt, now);
      return {
        key: `${item.kind}:${item.entity_id}`,
        entityId: item.entity_id,
        kind: item.kind,
        title: item.title,
        firmName: item.firm_name,
        clientName: item.client_name,
        priority: item.priority,
        status: item.status,
        dueAt: dueAt.toISOString(),
        ageHours: Number(
          Math.max(
            0,
            (now.getTime() - createdAt.getTime()) / 3_600_000,
          ).toFixed(1),
        ),
        slaState,
        detail: item.detail,
        actionHref: actionHref(item),
      };
    })
    .sort(
      (a, b) =>
        (a.slaState === "overdue" ? 0 : a.slaState === "due_soon" ? 1 : 2) -
          (b.slaState === "overdue" ? 0 : b.slaState === "due_soon" ? 1 : 2) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        Date.parse(a.dueAt) - Date.parse(b.dueAt),
    );
  const items = allItems.slice(0, 80);

  return {
    generatedAt: now.toISOString(),
    openItems: rawItems.length,
    overdueItems: allItems.filter((item) => item.slaState === "overdue").length,
    dueSoonItems: allItems.filter((item) => item.slaState === "due_soon")
      .length,
    highPriorityItems: allItems.filter((item) => item.priority === "high")
      .length,
    unassignedCases: rawItems.filter(
      (item) => item.kind === "operator_case" && item.unassigned,
    ).length,
    items,
  };
}
