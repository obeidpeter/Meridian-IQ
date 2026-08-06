import type { ProtectedFact } from "@workspace/db";
import { FILING_DUE_SOON_DAYS, countOpenFilings } from "../../filings/filings";
import { isAre, plural } from "../text";
import { countFact, forClient, type DataIntent } from "./shared";

// Filing Desk (Phase 3): the statutory-returns lookup. Every number comes
// from countOpenFilings — the SAME single fact function the digest,
// month-end close and compliance pack call, so Ask Clerk can never disagree
// with them. As-of-today only (no month parameter: an unfiled return stays
// on the clock until it is filed, whichever period it covers),
// client-pinnable (the SEC-03 forced own-party pin reduces it to the
// caller's own register rows). Deliberately linkless: ClerkAnswerLink only
// supports kind "invoice", and filing returns are not invoice rows.
export const RETURNS_INTENTS: readonly DataIntent[] = [
  {
    key: "data.open_filings",
    title:
      "statutory returns register (unfiled VAT/PAYE periods) — counts and the next filing date",
    accepts: { client: true },
    async run(firmId, params) {
      const counts = await countOpenFilings(firmId, params?.clientPartyId);
      const facts: ProtectedFact[] = [
        countFact("filings_unfiled", "Unfiled returns", counts.unfiled),
        countFact(
          "filings_due_soon",
          `Filings due within ${FILING_DUE_SOON_DAYS} days`,
          counts.dueSoon,
        ),
        countFact("filings_overdue", "Filings overdue", counts.overdue),
      ];
      if (counts.nextDueDate !== null) {
        facts.push({
          key: "next_filing_due",
          label: "Next filing due",
          kind: "date",
          value: counts.nextDueDate,
        });
      }
      return {
        text:
          counts.unfiled === 0
            ? `No statutory returns${forClient(params)} are awaiting filing.`
            : `${plural(counts.unfiled, "statutory return")}${forClient(params)} ${isAre(counts.unfiled)} awaiting filing — ${counts.dueSoon} due within ${FILING_DUE_SOON_DAYS} days and ${counts.overdue} already overdue. The next filing is due ${counts.nextDueDate}.`,
        facts,
      };
    },
  },
];
