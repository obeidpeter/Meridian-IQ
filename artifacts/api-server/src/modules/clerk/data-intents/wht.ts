import type { ProtectedFact } from "@workspace/db";
import { whtCreditTotals } from "../../wht/credits";
import { isAre, plural } from "../text";
import { amountFact, countFact, forClient, type DataIntent } from "./shared";

// WHT Desk: the withholding-credit lookup. Every number comes from
// whtCreditTotals — the SAME single SQL pass the ledger's totals, the
// digest, the month-end close and the compliance pack compose (countWhtChase
// delegates to it), so Ask Clerk can never disagree with them. As-of-today
// only (no month parameter: an outstanding credit note stays on the chase
// clock until it arrives, whichever period the deduction fell in),
// client-pinnable (the SEC-03 forced own-party pin reduces it to the
// caller's own ledger rows). Deliberately linkless: ClerkAnswerLink only
// supports kind "invoice", and the chase's unit of work is the credit row.
export const WHT_INTENTS: readonly DataIntent[] = [
  {
    key: "data.wht_credits",
    title:
      "withholding tax (WHT) credits — deductions recorded, credit notes still outstanding vs received",
    accepts: { client: true },
    async run(firmId, params) {
      const totals = await whtCreditTotals(firmId, params?.clientPartyId);
      const facts: ProtectedFact[] = [
        countFact(
          "wht_awaiting",
          "Withholding credits awaiting a credit note",
          totals.awaitingNote,
        ),
        amountFact(
          "wht_awaiting_amount",
          "Amount awaiting credit notes",
          totals.awaitingAmount,
        ),
        countFact(
          "wht_note_received",
          "Withholding credit notes received",
          totals.noteReceived,
        ),
      ];
      return {
        text:
          totals.awaitingNote === 0
            ? `No recorded withholding deductions${forClient(params)} are awaiting a buyer's credit note. ${plural(totals.noteReceived, "withholding credit note")} ${totals.noteReceived === 1 ? "has" : "have"} been received.`
            : `${plural(totals.awaitingNote, "recorded withholding deduction")}${forClient(params)} ${isAre(totals.awaitingNote)} still awaiting the buyer's withholding credit note — NGN ${totals.awaitingAmount} of claimable credit is undocumented. ${plural(totals.noteReceived, "withholding credit note")} ${totals.noteReceived === 1 ? "has" : "have"} been received.`,
        facts,
      };
    },
  },
];
