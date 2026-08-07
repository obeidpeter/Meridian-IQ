import { sql } from "drizzle-orm";
import { getDb, type ProtectedFact } from "@workspace/db";
import { onboardingStepLabel } from "@workspace/format/onboarding-copy";
import {
  listOnboardingRuns,
  onboardingRunView,
} from "../../onboarding/onboarding";
import { isAre, plural } from "../text";
import { countFact, forClient, type DataIntent } from "./shared";

// Onboard with Clerk: the onboarding-status lookup. Every number comes from
// the run rows the checklist itself maintains (modules/onboarding — the
// detection facts, never re-derived here), so Ask Clerk can never disagree
// with the console card. Client-pinnable (the SEC-03 forced own-party pin
// reduces it to the caller's own run); unpinned, it answers the firm's
// book-level counts. Deliberately linkless: ClerkAnswerLink only supports
// kind "invoice", and the run's unit of work is the checklist.
export const ONBOARDING_INTENTS: readonly DataIntent[] = [
  {
    key: "data.onboarding_status",
    title:
      "client onboarding progress — checklist steps settled vs pending, recorded gaps",
    accepts: { client: true },
    async run(firmId, params) {
      if (params?.clientPartyId) {
        const runs = await listOnboardingRuns(firmId, params.clientPartyId);
        const run = runs[0];
        if (!run) {
          return {
            text: `No onboarding run has been opened${forClient(params)}.`,
            facts: [countFact("onboarding_runs", "Onboarding runs", 0)],
          };
        }
        const view = await onboardingRunView(run);
        const settled = view.steps.filter((s) => s.status !== "pending");
        const pending = view.steps.filter((s) => s.status === "pending");
        const skipped = view.steps.filter((s) => s.status === "skipped");
        const facts: ProtectedFact[] = [
          countFact(
            "onboarding_settled",
            "Checklist steps settled",
            settled.length,
          ),
          countFact(
            "onboarding_pending",
            "Checklist steps pending",
            pending.length,
          ),
          countFact(
            "onboarding_skipped",
            "Recorded gaps (skipped steps)",
            skipped.length,
          ),
        ];
        const statusWord =
          view.status === "completed"
            ? "completed"
            : view.status === "abandoned"
              ? "closed without completing"
              : "in progress";
        const pendingLine =
          pending.length > 0
            ? ` Still pending: ${pending.map((s) => onboardingStepLabel(s.key)).join(", ")}.`
            : "";
        const gapLine =
          skipped.length > 0
            ? ` ${plural(skipped.length, "gap")} ${isAre(skipped.length)} on record (skipped with a reason).`
            : "";
        return {
          text: `Onboarding${forClient(params)} is ${statusWord}: ${settled.length} of ${view.steps.length} checklist steps settled.${pendingLine}${gapLine}`,
          facts,
        };
      }
      // Unpinned: the firm's book-level counts, one SQL pass.
      const [row] = (
        await getDb().execute<{ active: number; completed: number }>(sql`
          SELECT
            COUNT(*) FILTER (WHERE status = 'active')::int AS active,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
          FROM client_onboarding_runs
          WHERE firm_id = ${firmId}
        `)
      ).rows;
      const active = Number(row?.active ?? 0);
      const completed = Number(row?.completed ?? 0);
      return {
        text:
          active === 0
            ? `No client onboarding runs are in progress. ${plural(completed, "run")} ${completed === 1 ? "has" : "have"} completed.`
            : `${plural(active, "client onboarding run")} ${isAre(active)} in progress — the checklist settles itself as history, statements and consent land. ${plural(completed, "run")} ${completed === 1 ? "has" : "have"} completed.`,
        facts: [
          countFact("onboarding_active", "Onboarding runs in progress", active),
          countFact("onboarding_completed", "Onboarding runs completed", completed),
        ],
      };
    },
  },
];
