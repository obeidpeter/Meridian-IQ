import { sql } from "drizzle-orm";
import { lagosTodaySql, lagosWindowSql } from "../../../lib/lagos-time";
import {
  SUBMISSION_WINDOW_DAYS,
  UNSUBMITTED_STATE,
  pastSubmissionDeadline,
  withinDueSoonWindow,
} from "../../invoice/compliance-window";
import { isAre, plural } from "../text";
import {
  type DataIntent,
  forClient,
  invoiceAggregate,
  invoiceFacts,
  nameSample,
  sampleLinks,
} from "./shared";

// Statutory submission clocks — the five compliance lookups. Windows and
// boundaries come from the shared compliance-window fragments, so these
// answers can never disagree with the dashboards or the digest.
export const SUBMISSION_INTENTS: readonly DataIntent[] = [
  {
    key: "data.overdue_submissions",
    title: `invoices past the ${SUBMISSION_WINDOW_DAYS}-day statutory submission window (not yet submitted)`,
    accepts: { client: true },
    async run(firmId, params) {
      // The statutory deadline is Lagos MIDNIGHT STARTING day issue+window —
      // the shared compliance-window fragments carry the boundary, matching
      // the console/SME dashboards and the reminder sweep.
      const agg = await invoiceAggregate(
        firmId,
        sql`${UNSUBMITTED_STATE}
          AND ${pastSubmissionDeadline(lagosTodaySql())}`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No invoices${forClient(params)} are past the ${SUBMISSION_WINDOW_DAYS}-day submission window. Nothing is overdue today.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${isAre(agg.count)} past the ${SUBMISSION_WINDOW_DAYS}-day submission window: ${nameSample(agg)}. Submit these first to limit penalty exposure.`,
        facts: invoiceFacts(agg, "Invoices past the submission window"),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.due_soon_submissions",
    title: "invoices whose statutory submission deadline falls in the next 7 days",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await invoiceAggregate(
        firmId,
        sql`${UNSUBMITTED_STATE}
          AND ${withinDueSoonWindow(lagosTodaySql())}`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No submission deadlines${forClient(params)} fall in the next 7 days.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${isAre(agg.count)} due for submission within the next 7 days: ${nameSample(agg)}.`,
        facts: invoiceFacts(agg, "Deadlines in the next 7 days"),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.failed_submissions",
    title: "invoices whose rail submission failed and needs a fix",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status = 'failed'`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No invoices${forClient(params)} are currently in a failed submission state.`
            : `${plural(agg.count, "invoice")}${forClient(params)} failed rail submission: ${nameSample(agg)}. Open each invoice for the specific catalogue fix.`,
        facts: invoiceFacts(agg, "Failed submissions"),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.unsubmitted_invoices",
    title: "invoices still unsubmitted (sitting in draft or validated)",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('draft', 'validated')`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `Every invoice${forClient(params)} has been submitted — nothing is sitting in draft or validated.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${isAre(agg.count)} still unsubmitted (draft or validated): ${nameSample(agg)}.`,
        facts: invoiceFacts(agg, "Unsubmitted invoices"),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.submitted_this_month",
    title:
      "invoices accepted by the e-invoicing rails in a calendar month (this month unless another listed month is named)",
    accepts: { month: true, client: true },
    async run(firmId, params) {
      // The month window is the app-resolved first-of-month date (Lagos
      // calendar) through the shared lagosWindowSql predicate builder;
      // default = the current Lagos month, exactly as before.
      const monthWindow = params?.monthStart
        ? lagosWindowSql(sql`sa.created_at`, params.monthStart)
        : sql`date_trunc('month', sa.created_at AT TIME ZONE 'Africa/Lagos')
              = date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')`;
      const agg = await invoiceAggregate(
        firmId,
        sql`EXISTS (
          SELECT 1 FROM submission_attempts sa
          WHERE sa.invoice_id = i.id
            AND sa.status = 'accepted'
            AND ${monthWindow}
        )`,
        params,
      );
      const period = params?.monthLabel
        ? `in ${params.monthLabel}`
        : "so far this month";
      return {
        text:
          agg.count === 0
            ? `No invoices${forClient(params)} were accepted by the rails ${period}.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${agg.count === 1 ? "was" : "were"} accepted by the rails ${period}, NGN ${agg.totalNgn} in total: ${nameSample(agg)}.`,
        facts: invoiceFacts(
          agg,
          `Accepted by the rails ${period}`,
          true,
        ),
        ...sampleLinks(agg),
      };
    },
  }
];
