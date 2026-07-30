import { sql } from "drizzle-orm";
import { getDb, type ProtectedFact } from "@workspace/db";
import { lagosWindowSql } from "../../../lib/lagos-time";
import { BILL_UNPAID } from "../../invoice/payables";
import {
  computeFirmVatPositions,
  computeVatPosition,
  vatPositionMonths,
} from "../../invoice/vat-position";
import { packMonthDocsSql } from "../vat-pack";
import { monthLabel } from "../client-statement";
import { plural } from "../text";
import {
  type DataIntent,
  billAggregate,
  countFact,
  forClient,
  invoiceAggregate,
} from "./shared";

// The comparison lookups (Ask 2.0). Both are pure composition over the
// catalogue's existing one-homes — invoiceAggregate over the shared Lagos
// month window, computeVatPosition/computeFirmVatPositions for the VAT pair,
// billAggregate for the payables pair, packMonthDocsSql for the per-client
// ranking — so a delta can never disagree with the point lookups it compares.
// Both are LINKLESS (billAggregate's posture and reason: the payables side is
// bills, which are not invoice-detail linkable for a client asker), and both
// are APPENDED LAST in index.ts: the catalogue order is model-facing and
// append-only.

// First day of the Lagos month before `monthStart` (YYYY-MM-01). Date.UTC
// month overflow carries January back into the prior year, the
// lagosMonthOptions idiom. Exported for tests.
export function priorMonthStart(monthStart: string): string {
  const [y, m] = monthStart.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-01`;
}

// data.submitted_this_month's accepted-in-month membership (submissions.ts),
// composed from the SAME shared lagosWindowSql builder — the Lagos month
// boundary has exactly one spelling; only the EXISTS shell repeats here.
function acceptedInMonth(monthStart: string) {
  return sql`EXISTS (
    SELECT 1 FROM submission_attempts sa
    WHERE sa.invoice_id = i.id
      AND sa.status = 'accepted'
      AND ${lagosWindowSql(sql`sa.created_at`, monthStart)}
  )`;
}

// Unpaid captured bills whose payment falls DUE inside the month — the
// data.payables_due basis (BILL_UNPAID + a due-date bound) with the rolling
// 7-day horizon swapped for the pinned calendar month. due_date is a plain
// DATE column, so the month bound is date arithmetic (the monthBillsSql
// shape), not the timestamptz window builder.
function dueInMonth(monthStart: string) {
  return sql`${BILL_UNPAID}
    AND i.due_date IS NOT NULL
    AND i.due_date >= ${monthStart}::date
    AND i.due_date < (${monthStart}::date + interval '1 month')`;
}

// "+200.00" / "-300.00" — every delta is phrased WITH its sign, so a drop
// can never read as growth. ASCII sign, explicit "+" on zero and gains.
function signedDelta(n: number): string {
  return `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(2)}`;
}

// The count counterpart ("+2" invoices), same sign discipline.
function signedCount(n: number): string {
  return `${n < 0 ? "-" : "+"}${Math.abs(n)}`;
}

function amountFact(
  key: string,
  label: string,
  value: string,
): ProtectedFact {
  return { key, label, kind: "amount", value, unit: "NGN" };
}

export const DELTA_INTENTS: readonly DataIntent[] = [
  {
    key: "data.month_delta",
    title:
      "how a calendar month compares with the month before it — rails-accepted submissions, net VAT position and supplier bills due, each with its change (this month vs last unless another listed month is named)",
    accepts: { month: true, client: true },
    async run(firmId, params) {
      // Month resolution mirrors data.vat_position: the app-resolved
      // first-of-month key, defaulting to the current Lagos month; the
      // predecessor is derived from it, never guessed by the model.
      const monthStart = params?.monthStart ?? vatPositionMonths()[0];
      const prevStart = priorMonthStart(monthStart);
      const label = params?.monthLabel ?? monthLabel(monthStart);
      const prevLabel = monthLabel(prevStart);

      // Submissions: the accepted-in-month aggregate for both months —
      // invoiceAggregate applies the client pin (supplier side) and the
      // firm-wide receivable orientation exactly as the point lookup does.
      const cur = await invoiceAggregate(
        firmId,
        acceptedInMonth(monthStart),
        params,
      );
      const prev = await invoiceAggregate(
        firmId,
        acceptedInMonth(prevStart),
        params,
      );
      // Net VAT: the position module's own numbers — per-client under a pin
      // (a client asker's forced own-party pin lands here, SEC-03), the
      // firm rollup totals otherwise.
      const netVat = async (start: string): Promise<string> =>
        params?.clientPartyId
          ? (await computeVatPosition(firmId, params.clientPartyId, start))
              .netVat
          : (await computeFirmVatPositions(firmId, start)).totals.netVat;
      const curVat = await netVat(monthStart);
      const prevVat = await netVat(prevStart);
      // Payables: unpaid bills due in each month — billAggregate pins the
      // BUYER side under a client pin, the bills scope wall.
      const curDue = await billAggregate(
        firmId,
        dueInMonth(monthStart),
        params,
      );
      const prevDue = await billAggregate(
        firmId,
        dueInMonth(prevStart),
        params,
      );

      const submittedDelta = Number(cur.totalNgn) - Number(prev.totalNgn);
      const countDelta = cur.count - prev.count;
      const vatDelta = Number(curVat) - Number(prevVat);
      const dueDelta = Number(curDue.totalNgn) - Number(prevDue.totalNgn);
      return {
        text:
          `Comparing ${label} with ${prevLabel}${forClient(params)}: ` +
          `rails-accepted invoices NGN ${cur.totalNgn} (${plural(cur.count, "invoice")}) vs NGN ${prev.totalNgn} (${plural(prev.count, "invoice")}) — a change of ${signedDelta(submittedDelta)} NGN and ${signedCount(countDelta)} invoices. ` +
          `Net VAT NGN ${curVat} vs NGN ${prevVat} (${signedDelta(vatDelta)} NGN). ` +
          `Supplier bills due NGN ${curDue.totalNgn} vs NGN ${prevDue.totalNgn} (${signedDelta(dueDelta)} NGN).`,
        // The six underlying month numbers plus the three signed deltas —
        // every figure platform-computed, nothing model-authored.
        facts: [
          amountFact("submitted_total", `Accepted total (${label})`, cur.totalNgn),
          amountFact(
            "submitted_total_prior",
            `Accepted total (${prevLabel})`,
            prev.totalNgn,
          ),
          amountFact(
            "submitted_delta",
            "Accepted total change",
            signedDelta(submittedDelta),
          ),
          amountFact("net_vat", `Net VAT (${label})`, curVat),
          amountFact("net_vat_prior", `Net VAT (${prevLabel})`, prevVat),
          amountFact("net_vat_delta", "Net VAT change", signedDelta(vatDelta)),
          amountFact("payables_due", `Bills due (${label})`, curDue.totalNgn),
          amountFact(
            "payables_due_prior",
            `Bills due (${prevLabel})`,
            prevDue.totalNgn,
          ),
          amountFact(
            "payables_due_delta",
            "Bills due change",
            signedDelta(dueDelta),
          ),
        ],
        // Deliberately NO links (billAggregate's posture): the payables side
        // is bills, not invoice-detail linkable for a client asker.
      };
    },
  },
  {
    key: "data.client_breakdown",
    title:
      "which clients drove the change from the month before — the firm's top movers up and down in rails-accepted invoice totals (firm-wide; this month vs last unless another listed month is named)",
    // Firm-only by design: the answer RANKS the firm's clients against each
    // other, which is exactly the firm-wide content the client-safe subset
    // exists to withhold — accepts.client stays false so a client pin
    // refuses upstream in ask.ts, and the intent never joins
    // CLIENT_SAFE_INTENT_KEYS.
    accepts: { month: true },
    async run(firmId, params) {
      if (params?.clientPartyId) {
        // Defensive only: ask.ts refuses a model-picked client via
        // accepts.client=false and refuses the forced client pin for any
        // non-client-capable intent, so a pin here is a programming error —
        // answer honestly rather than silently rank firm-wide for a pinned
        // caller.
        return {
          text: "This breakdown ranks the firm's clients against each other and cannot be filtered to one client.",
          facts: [],
        };
      }
      const monthStart = params?.monthStart ?? vatPositionMonths()[0];
      const prevStart = priorMonthStart(monthStart);
      const label = params?.monthLabel ?? monthLabel(monthStart);
      const prevLabel = monthLabel(prevStart);
      // ONE grouped pass over BOTH months' accepted documents, membership by
      // packMonthDocsSql — the VAT pack's own accepted-in-month fragment
      // (issue-month bucketing, accepted attempt required, cancelled
      // excluded), so this ranking and the pack agree by construction. The
      // per-row month split needs only one comparison: every row the OR
      // admits lies in [prevStart, monthStart + 1 month), so issue_date >=
      // monthStart IS "the pinned month". Totals mirror the pack row's
      // acceptedTotal semantics: invoice-kind documents only (credit notes
      // participate in the pack's VAT netting, not its gross total).
      const rows = (
        await getDb().execute<{
          id: string;
          name: string;
          cur: string;
          prev: string;
        }>(sql`
          SELECT
            i.supplier_party_id AS id,
            MIN(p.legal_name) AS name,
            COALESCE(SUM(i.grand_total) FILTER (
              WHERE i.kind = 'invoice' AND i.issue_date >= ${monthStart}::date
            ), 0)::text AS cur,
            COALESCE(SUM(i.grand_total) FILTER (
              WHERE i.kind = 'invoice' AND i.issue_date < ${monthStart}::date
            ), 0)::text AS prev
          FROM invoices i
          JOIN parties p ON p.id = i.supplier_party_id
          WHERE (${packMonthDocsSql(firmId, monthStart)})
             OR (${packMonthDocsSql(firmId, prevStart)})
          GROUP BY i.supplier_party_id
        `)
      ).rows;
      const movers = rows
        .map((r) => ({
          id: r.id,
          name: r.name,
          delta: Number(r.cur) - Number(r.prev),
        }))
        .filter((m) => m.delta !== 0)
        // Largest absolute swing first; ties break by name so the ranking is
        // deterministic whatever the scan order.
        .sort(
          (a, b) =>
            Math.abs(b.delta) - Math.abs(a.delta) ||
            a.name.localeCompare(b.name),
        );
      const up = movers.filter((m) => m.delta > 0);
      const down = movers.filter((m) => m.delta < 0);
      if (movers.length === 0) {
        return {
          text: `No client's rails-accepted total changed between ${label} and ${prevLabel} — nothing to rank.`,
          facts: [
            countFact("movers_up", "Clients up vs prior month", 0),
            countFact("movers_down", "Clients down vs prior month", 0),
          ],
        };
      }
      // The nameSample idiom: name up to 3 movers per direction, honest
      // remainder for the rest.
      const TOP = 3;
      const nameMovers = (list: typeof movers): string => {
        const shown = list
          .slice(0, TOP)
          .map((m) => `${m.name} (${signedDelta(m.delta)} NGN)`)
          .join(", ");
        const rest = list.length - Math.min(list.length, TOP);
        return rest > 0 ? `${shown} and ${rest} more` : shown;
      };
      const moverFacts = (list: typeof movers, prefix: string): ProtectedFact[] =>
        list
          .slice(0, TOP)
          .map((m, idx) =>
            amountFact(`${prefix}_${idx + 1}`, m.name, signedDelta(m.delta)),
          );
      return {
        text:
          `Movers between ${label} and ${prevLabel} by rails-accepted invoice totals: ` +
          (up.length > 0 ? `up — ${nameMovers(up)}` : "no client moved up") +
          "; " +
          (down.length > 0
            ? `down — ${nameMovers(down)}`
            : "no client moved down") +
          ".",
        facts: [
          countFact("movers_up", "Clients up vs prior month", up.length),
          countFact("movers_down", "Clients down vs prior month", down.length),
          ...moverFacts(up, "up"),
          ...moverFacts(down, "down"),
        ],
        // Linkless: a client ranking names no individual invoices.
      };
    },
  },
];
