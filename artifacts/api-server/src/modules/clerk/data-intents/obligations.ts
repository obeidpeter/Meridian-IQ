import type { ProtectedFact } from "@workspace/db";
import {
  OBLIGATION_DUE_SOON_DAYS,
  countOpenObligations,
} from "../../obligations/obligations";
import { isAre, plural } from "../text";
import { countFact, forClient, type DataIntent } from "./shared";

// Notice Desk (Task #199): the obligations lookup. Every number comes from
// countOpenObligations — the SAME single fact function the digest, month-end
// close and compliance pack call, so Ask Clerk can never disagree with them.
// As-of-today only (no month parameter: a response deadline is live until
// answered), client-pinnable (the SEC-03 forced own-party pin reduces it to
// the caller's own notices). Deliberately linkless: ClerkAnswerLink only
// supports kind "invoice", and obligations are not invoice rows.
export const OBLIGATION_INTENTS: readonly DataIntent[] = [
  {
    key: "data.open_obligations",
    title:
      "open authority obligations (tax-authority notices awaiting a response) — counts and the nearest response deadline",
    accepts: { client: true },
    async run(firmId, params) {
      const counts = await countOpenObligations(firmId, params?.clientPartyId);
      const facts: ProtectedFact[] = [
        countFact("obligations_open", "Open obligations", counts.open),
        countFact(
          "obligations_due_soon",
          `Responses due within ${OBLIGATION_DUE_SOON_DAYS} days`,
          counts.dueSoon,
        ),
        countFact("obligations_overdue", "Responses overdue", counts.overdue),
      ];
      if (counts.nearestDue !== null) {
        facts.push({
          key: "nearest_due",
          label: "Nearest response due",
          kind: "date",
          value: counts.nearestDue,
        });
      }
      return {
        text:
          counts.open === 0
            ? `No authority notices${forClient(params)} are awaiting a response.`
            : `${plural(counts.open, "authority notice")}${forClient(params)} ${isAre(counts.open)} awaiting a response — ${counts.dueSoon} due within ${OBLIGATION_DUE_SOON_DAYS} days and ${counts.overdue} already overdue. The nearest response is due ${counts.nearestDue}.`,
        facts,
      };
    },
  },
];
