import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString, lagosTodaySql } from "../../../lib/lagos-time";
import {
  firmMoneySummary,
  isChaseEligible,
  listChaseRows,
  receivableProjections,
} from "../../invoice/cashflow";
import { OUTSTANDING } from "../../invoice/receivables";
import { isAre, plural } from "../text";
import {
  RECEIVABLE_AGE_DAYS,
  type DataIntent,
  chaseLinks,
  countFact,
  forClient,
  invoiceAggregate,
  invoiceFacts,
  nameSample,
  sampleLinks,
} from "./shared";

// The money lookups — receivables, expected inflows and the chase list.
// Firm-wide branches phrase the SAME firmMoneySummary the weekly digest
// uses; per-client branches run the projections directly.
export const MONEY_INTENTS: readonly DataIntent[] = [
  {
    key: "data.aged_receivables",
    title: `receivables more than ${RECEIVABLE_AGE_DAYS} days old (submitted but unpaid)`,
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('submitted', 'stamped', 'confirmed')
          AND COALESCE(i.due_date, i.issue_date) < ${lagosTodaySql()} - ${RECEIVABLE_AGE_DAYS}::int`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No receivables${forClient(params)} are more than ${RECEIVABLE_AGE_DAYS} days old.`
            : `${plural(agg.count, "receivable")}${forClient(params)} ${isAre(agg.count)} more than ${RECEIVABLE_AGE_DAYS} days old, NGN ${agg.totalNgn} in total: ${nameSample(agg)}. Consider chasing payment.`,
        facts: invoiceFacts(agg, `Receivables over ${RECEIVABLE_AGE_DAYS} days`, true),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.outstanding_receivables",
    title:
      "outstanding receivables — who owes money right now (issued invoices not yet paid)",
    accepts: { client: true },
    async run(firmId, params) {
      // The exported OUTSTANDING fragment in BOTH queries — one spelling of
      // the receivables definition, so this intent and the receivables card
      // cannot drift apart under future edits.
      const agg = await invoiceAggregate(firmId, sql`${OUTSTANDING}`, params);
      // Who owes: top debtors keyed by PARTY (two parties sharing a legal
      // name stay two debtors, matching the receivables card's grouping).
      const clientFilter = params?.clientPartyId
        ? sql` AND i.supplier_party_id = ${params.clientPartyId}`
        : sql``;
      const debtors = (
        await getDb().execute<{ buyer_name: string; owed: string }>(sql`
          SELECT p.legal_name AS buyer_name,
            SUM(i.grand_total)::numeric(18,2)::text AS owed
          FROM invoices i
          JOIN parties p ON p.id = i.buyer_party_id
          WHERE ${OUTSTANDING} AND i.firm_id = ${firmId}${clientFilter}
          GROUP BY i.buyer_party_id, p.legal_name
          ORDER BY SUM(i.grand_total) DESC
          LIMIT 3
        `)
      ).rows;
      const debtorLine =
        debtors.length > 0
          ? ` Top debtors: ${debtors.map((d) => `${d.buyer_name} (NGN ${d.owed})`).join(", ")}.`
          : "";
      return {
        text:
          agg.count === 0
            ? `Nothing is outstanding${forClient(params)} — every issued invoice has been paid or otherwise closed.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${isAre(agg.count)} outstanding, NGN ${agg.totalNgn} in total.${debtorLine}`,
        facts: [
          ...invoiceFacts(agg, "Outstanding invoices", true),
          ...(debtors.length > 0
            ? [
                {
                  key: "top_debtors",
                  label: "Top debtors",
                  kind: "text" as const,
                  value: debtors
                    .map((d) => `${d.buyer_name}: NGN ${d.owed}`)
                    .join("; "),
                },
              ]
            : []),
        ],
      };
    },
  },
  {
    key: "data.expected_inflows",
    title:
      "money expected to be paid in the coming week, projected from each customer's own payment rhythm",
    accepts: { client: true },
    async run(firmId, params) {
      // Per client: the projections directly; firm-wide: the shared summary
      // (the same numbers the weekly digest phrases).
      if (params?.clientPartyId) {
        const projections = await receivableProjections(
          firmId,
          params.clientPartyId,
        );
        let count = 0;
        let total = 0;
        let late = 0;
        for (const p of projections) {
          if (p.daysBeyondExpected > 0) late += 1;
          else if (p.daysBeyondExpected > -7) {
            count += 1;
            const amount = Number(p.grandTotal);
            if (Number.isFinite(amount)) total += amount;
          }
        }
        return {
          text:
            count === 0
              ? `No payments${forClient(params)} are expected in the coming week${late > 0 ? `, and ${plural(late, "invoice")} ${isAre(late)} already past the expected payment date` : ""}.`
              : `${plural(count, "invoice")}${forClient(params)} totalling NGN ${total.toFixed(2)} ${isAre(count)} expected to be paid in the coming week, based on each customer's own payment rhythm${late > 0 ? `; ${plural(late, "invoice")} ${isAre(late)} already past the expected date` : ""}.`,
          facts: [
            countFact("expected_week", "Expected in the coming week", count),
            {
              key: "expected_week_total",
              label: "Expected value (coming week)",
              kind: "amount",
              value: total.toFixed(2),
              unit: "NGN",
            },
            countFact("past_expected", "Already past expected date", late),
          ],
        };
      }
      const summary = await firmMoneySummary(firmId);
      const scope = summary.truncated
        ? "across your largest client books"
        : "across your clients";
      return {
        text:
          summary.expectedWeekCount === 0
            ? `No payments are expected ${scope} in the coming week${summary.overdueExpectedCount > 0 ? `, and ${plural(summary.overdueExpectedCount, "invoice")} ${isAre(summary.overdueExpectedCount)} already past the expected payment date` : ""}.`
            : `${plural(summary.expectedWeekCount, "invoice")} totalling NGN ${summary.expectedWeekTotalNgn} ${isAre(summary.expectedWeekCount)} expected to be paid ${scope} in the coming week, based on each customer's own payment rhythm${summary.overdueExpectedCount > 0 ? `; ${plural(summary.overdueExpectedCount, "invoice")} ${isAre(summary.overdueExpectedCount)} already past the expected date` : ""}.`,
        facts: [
          countFact(
            "expected_week",
            "Expected in the coming week",
            summary.expectedWeekCount,
          ),
          {
            key: "expected_week_total",
            label: "Expected value (coming week)",
            kind: "amount",
            value: summary.expectedWeekTotalNgn,
            unit: "NGN",
          },
          countFact(
            "past_expected",
            "Already past expected date",
            summary.overdueExpectedCount,
          ),
        ],
      };
    },
  },
  {
    key: "data.chase_list",
    title:
      "which unpaid invoices are most worth chasing (past both the due date and the customer's usual payment rhythm)",
    accepts: { client: true },
    async run(firmId, params) {
      const nameRows = (
        rows: { buyerName: string; invoiceNumber: string; daysBeyondExpected: number }[],
      ) =>
        rows
          .slice(0, 3)
          .map(
            (r) =>
              `${r.buyerName} — ${r.invoiceNumber} (${r.daysBeyondExpected}d beyond expectation)`,
          )
          .join("; ");
      if (params?.clientPartyId) {
        // The COUNT comes from the uncapped, all-currency projections via
        // the shared eligibility predicate — the display list (primary
        // currency, capped) only supplies the named rows, so the number
        // presented as definitive never inherits a display cap.
        const projections = await receivableProjections(
          firmId,
          params.clientPartyId,
        );
        const today = lagosDateString();
        const eligible = projections.filter((p) =>
          isChaseEligible(p, today),
        ).length;
        const rows = await listChaseRows(firmId, params.clientPartyId);
        return {
          text:
            eligible === 0
              ? `Nothing${forClient(params)} is currently worth chasing — no invoice is past both its due date and the customer's usual payment rhythm.`
              : `${plural(eligible, "invoice")}${forClient(params)} ${isAre(eligible)} worth chasing: ${nameRows(rows)}. Open an invoice to draft a payment reminder.`,
          facts: [countFact("chase_count", "Worth chasing", eligible)],
          ...chaseLinks(rows),
        };
      }
      const summary = await firmMoneySummary(firmId);
      const scope = summary.truncated
        ? "across your largest client books"
        : "across your clients";
      return {
        text:
          summary.chaseCount === 0
            ? `Nothing ${scope} is currently worth chasing — no invoice is past both its due date and the customer's usual payment rhythm.`
            : `${plural(summary.chaseCount, "invoice")} ${scope} ${isAre(summary.chaseCount)} worth chasing: ${nameRows(
                summary.topChase.map((r) => ({
                  ...r,
                  buyerName: `${r.buyerName} (${r.clientName})`,
                })),
              )}.`,
        facts: [countFact("chase_count", "Worth chasing", summary.chaseCount)],
        ...chaseLinks(summary.topChase),
      };
    },
  }
];
