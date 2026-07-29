import { sql } from "drizzle-orm";
import { lagosTodaySql } from "../../../lib/lagos-time";
import { BILL_UNPAID } from "../../invoice/payables";
import { isAre, plural } from "../text";
import {
  type DataIntent,
  billAggregate,
  forClient,
  invoiceFacts,
  nameSample,
} from "./shared";

// The payables mirror — supplier bills due and the total owed. Buyer-side
// billAggregate throughout; deliberately linkless (bills are not
// invoice-detail linkable for a client asker).
export const PAYABLES_INTENTS: readonly DataIntent[] = [
  {
    key: "data.payables_due",
    title:
      "supplier bills due within the next 7 days or already overdue (unpaid captured vendor invoices)",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await billAggregate(
        firmId,
        sql`${BILL_UNPAID}
          AND i.due_date IS NOT NULL
          AND i.due_date <= ${lagosTodaySql()} + 7`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No supplier bills${forClient(params)} are due within the next 7 days or overdue.`
            : `${plural(agg.count, "supplier bill")}${forClient(params)} ${isAre(agg.count)} due within the next 7 days or already overdue, NGN ${agg.totalNgn} in total: ${nameSample(agg)}. Worth scheduling the payments.`,
        facts: invoiceFacts(agg, "Bills due within 7 days or overdue", true),
        // No links (see billAggregate): bill rows are not invoice-detail
        // linkable for a client asker.
      };
    },
  },
  {
    key: "data.total_owed",
    title:
      "the total owed to suppliers right now (unpaid captured vendor bills, whatever their due date)",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await billAggregate(firmId, sql`${BILL_UNPAID}`, params);
      return {
        text:
          agg.count === 0
            ? `Nothing is owed to suppliers${forClient(params)} — every captured bill has payment evidence.`
            : `${plural(agg.count, "supplier bill")}${forClient(params)} ${isAre(agg.count)} unpaid, NGN ${agg.totalNgn} owed in total: ${nameSample(agg)}.`,
        facts: invoiceFacts(agg, "Unpaid supplier bills", true),
        // No links (see billAggregate).
      };
    },
  }
];
