import {
  computeFirmVatPositions,
  computeVatPosition,
} from "../../invoice/vat-position";
import { computePenaltyExposure } from "../../invoice/penalty-exposure";
import { isAre, plural } from "../text";
import {
  type DataIntent,
  amountFact,
  countFact,
  forClient,
  resolveMonth,
} from "./shared";

// The filing lookups — the month's VAT position and the s.104 penalty
// exposure estimate, each delegating to the module that powers its own
// dashboard card so Ask can never disagree with it.
export const FILING_INTENTS: readonly DataIntent[] = [
  {
    key: "data.vat_position",
    title:
      "the month's VAT position — output VAT from issued documents versus input VAT from supplier bills, with the verified (defensible) split (this month unless another listed month is named)",
    accepts: { month: true, client: true },
    async run(firmId, params) {
      // Month resolution: the shared "this month unless pinned" rule
      // (resolveMonth in shared.ts — the /vat-position route's own default).
      const { monthStart, label } = resolveMonth(params);
      const period = `in ${label}`;
      // Deliberately NO answer links, per client or firm-wide (billAggregate's
      // posture and reason): the position's input side is bills, which are
      // not invoice-detail linkable for a client asker (the SEC-03 invoice
      // detail routes are supplier-pinned).
      if (params?.clientPartyId) {
        const p = await computeVatPosition(
          firmId,
          params.clientPartyId,
          monthStart,
        );
        const fx =
          p.excludedForFx > 0
            ? ` ${plural(p.excludedForFx, "non-NGN document")} without a captured FX rate ${isAre(p.excludedForFx)} excluded from these totals.`
            : "";
        return {
          text: `VAT position${forClient(params)} ${period}: output VAT NGN ${p.outputVat} from ${plural(p.outputInvoiceCount, "rails-accepted invoice")} (credit notes netted), input VAT NGN ${p.inputVat} on ${plural(p.billCount, "captured supplier bill")}, of which NGN ${p.inputVatVerified} is verified against the national record. Net VAT NGN ${p.netVat}; defensible net (verified input only) NGN ${p.defensibleNetVat}.${fx}`,
          facts: [
            amountFact("output_vat", "Output VAT", p.outputVat),
            amountFact("input_vat", "Input VAT", p.inputVat),
            amountFact(
              "input_vat_verified",
              "Verified input VAT",
              p.inputVatVerified,
            ),
            amountFact("net_vat", "Net VAT", p.netVat),
            amountFact(
              "defensible_net_vat",
              "Defensible net VAT",
              p.defensibleNetVat,
            ),
            ...(p.excludedForFx > 0
              ? [
                  countFact(
                    "excluded_for_fx",
                    "Documents excluded for missing FX rate",
                    p.excludedForFx,
                  ),
                ]
              : []),
          ],
        };
      }
      const f = await computeFirmVatPositions(firmId, monthStart);
      return {
        text: `VAT position across ${plural(f.rows.length, "engaged client")} ${period}: output VAT NGN ${f.totals.outputVat}, input VAT NGN ${f.totals.inputVat} (NGN ${f.totals.inputVatVerified} verified against the national record). Net VAT NGN ${f.totals.netVat}; defensible net (verified input only) NGN ${f.totals.defensibleNetVat}.`,
        facts: [
          amountFact("output_vat", "Output VAT", f.totals.outputVat),
          amountFact("input_vat", "Input VAT", f.totals.inputVat),
          amountFact(
            "input_vat_verified",
            "Verified input VAT",
            f.totals.inputVatVerified,
          ),
          amountFact("net_vat", "Net VAT", f.totals.netVat),
          amountFact(
            "defensible_net_vat",
            "Defensible net VAT",
            f.totals.defensibleNetVat,
          ),
        ],
      };
    },
  },
  {
    key: "data.penalty_exposure",
    title:
      "estimated s.104 penalty exposure for invoices past the submission window and still unsubmitted (per-band estimate; the platform does not hold turnover)",
    accepts: { client: true },
    async run(firmId, params) {
      const exposure = await computePenaltyExposure(
        firmId,
        params?.clientPartyId,
      );
      if (exposure.overdueCount === 0) {
        return {
          text: `No invoices${forClient(params)} are past the submission window, so there is no estimated s.104 exposure right now.`,
          facts: [countFact("overdue_submissions", "Past the window", 0)],
        };
      }
      return {
        text:
          `${plural(exposure.overdueCount, "invoice")}${forClient(params)} ${isAre(exposure.overdueCount)} past the submission window and still unsubmitted. ` +
          `Estimated s.104 exposure under MeridianIQ's published model: NGN ${exposure.exposure.small} (small turnover band) to NGN ${exposure.exposure.large} (large band). ` +
          `An estimate, not legal or tax advice — submitting the overdue paper removes the exposure.`,
        facts: [
          countFact(
            "overdue_submissions",
            "Past the window",
            exposure.overdueCount,
          ),
          amountFact(
            "exposure_floor",
            "Exposure floor (small band)",
            exposure.exposure.small,
          ),
          amountFact(
            "exposure_ceiling",
            "Exposure ceiling (large band)",
            exposure.exposure.large,
          ),
        ],
        links: exposure.sampleInvoices.map((r) => ({
          label: r.invoiceNumber,
          kind: "invoice" as const,
          id: r.invoiceId,
        })),
      };
    },
  }
];
