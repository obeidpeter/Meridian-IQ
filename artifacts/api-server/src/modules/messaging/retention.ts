import { sql } from "drizzle-orm";
import { getDb, runInBypassContext } from "@workspace/db";
import { registerSweep } from "../pipeline/pipeline";
import { atMostHourly } from "../clerk/watch-shared";

// Messages-ledger retention. Every alert the platform sends lands one row in
// `messages` forever — reminders, digests, statements, B2C alerts — so the
// ledger grows without bound (one row per send, multiplied by failover
// re-inserts). The rows are POINTER-ONLY by construction (SEC-12: template
// key, opaque refs, status — never amounts, names, TINs or documents), so
// deleting old ones destroys no tenant data and no evidence: the audit
// ledger and the domain tables carry the durable trail. What a deleted row
// costs is a stale entry falling off the bottom of someone's notification
// feed — months-old "something happened, open the app" pointers nobody will
// scroll back to.
//
// Safe against the ledger's other writers by AGE: delivery webhooks
// (markDelivery) and provider status updates only ever touch rows minutes-
// to-days after the send — a row old enough for this sweep (default 180
// days) can no longer receive one, and a webhook for an already-deleted id
// updates zero rows harmlessly. The mark-read path likewise only touches
// rows a feed still serves.
//
// Posture mirrors the other retention sweeps (sweepPipelineRetention,
// sweepExpiredCaseContent): bypass context (worker, no request principal;
// `messages` carries no RLS anyway), idempotent (deleting an already-deleted
// row is a no-op — two instances racing the same batch is harmless
// redundancy), and hourly cadence via atMostHourly (retention at day
// granularity gains nothing from the every-minute sweep loop). Deletes are
// BOUNDED — oldest-first, LIMIT 1000 per pass — so a first run against a
// long-lived ledger trims gradually instead of holding a giant delete's
// locks; at one batch per hour the backlog drains at up to 24k rows/day
// while steady-state passes delete a handful.

const BATCH_LIMIT = 1000;

// Env is read per pass so operators can tune without a restart. A malformed
// or non-positive value DISABLES the sweep rather than deleting aggressively
// (the same fail-safe stance as CLERK_CONTENT_RETENTION_DAYS).
function retentionDays(): number {
  const days = Number(process.env.MESSAGES_RETENTION_DAYS ?? 180);
  return Number.isFinite(days) && days >= 1 ? days : 0;
}

// One bounded batch per call; returns how many rows were deleted (0 = done
// or disabled). Exported for tests, which call it directly.
export async function sweepMessagesRetention(): Promise<number> {
  const days = retentionDays();
  if (days < 1) return 0;
  return runInBypassContext(async () => {
    // Raw SQL: DELETE has no LIMIT, so bound the batch via an id subquery.
    // Oldest first, so repeated passes walk the backlog front-to-back.
    const result = await getDb().execute<{ id: string }>(sql`
      DELETE FROM messages
      WHERE id IN (
        SELECT id FROM messages
        WHERE created_at < now() - make_interval(days => ${days})
        ORDER BY created_at
        LIMIT ${BATCH_LIMIT}
      )
      RETURNING id
    `);
    return result.rows.length;
  });
}

registerSweep(atMostHourly(sweepMessagesRetention));
