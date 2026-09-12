import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  engagementsTable,
  evidenceEventsTable,
  evidenceRequestsTable,
  featureFlagOverridesTable,
  featureFlagsTable,
  getDb,
  membershipsTable,
  messagesTable,
  runInBypassContext,
} from "@workspace/db";
import {
  lagosDateString,
  lagosMidnight,
  lagosMidnightPlusDays,
} from "../../lib/lagos-time";
import { isFeatureEnabled } from "../flags/flags";
import { appendAudit } from "../audit/audit";
import { pointerEntityRef, recipientRefFor } from "../messaging/recipient-ref";

export const EVIDENCE_REMINDER_BATCH_LIMIT = 100;
export const EVIDENCE_REMINDER_TIMEOUT_MS = 30_000;

export interface EvidenceReminderOptions {
  firmId?: string;
  signal?: AbortSignal;
  deadline?: number;
  batchLimit?: number;
}

async function boundDatabaseStage(deadline: number): Promise<void> {
  const timeout = String(Math.max(1, Math.min(5_000, deadline - Date.now())));
  await getDb().execute(sql`select
    set_config('statement_timeout', ${timeout}, true),
    set_config('lock_timeout', '1000', true)`);
}

/** Inbox-only delivery: each daily claim, notification and event commits together. */
export async function sweepEvidenceReminders(
  now = new Date(),
  options: EvidenceReminderOptions = {},
): Promise<number> {
  const deadline = Math.min(
    options.deadline ?? Infinity,
    Date.now() + EVIDENCE_REMINDER_TIMEOUT_MS - 5_000,
  );
  const stopped = () =>
    Boolean(options.signal?.aborted) || Date.now() >= deadline;
  if (stopped()) return 0;
  const batchLimit = Math.min(
    EVIDENCE_REMINDER_BATCH_LIMIT,
    Math.max(
      1,
      Math.floor(
        Number.isFinite(options.batchLimit)
          ? options.batchLimit!
          : EVIDENCE_REMINDER_BATCH_LIMIT,
      ),
    ),
  );
  const date = lagosDateString(now);
  const start = lagosMidnight(date);
  const end = lagosMidnightPlusDays(date, 1);
  // Exclude dark firms before LIMIT so they cannot starve an enabled cohort.
  const enabled = sql`coalesce(
    (select ${featureFlagOverridesTable.enabled} from ${featureFlagOverridesTable}
      where ${featureFlagOverridesTable.flagKey} = 'evidence_hub'
        and ${featureFlagOverridesTable.firmId} = ${evidenceRequestsTable.firmId}),
    (select ${featureFlagsTable.enabled} from ${featureFlagsTable}
      where ${featureFlagsTable.key} = 'evidence_hub'), false
  )`;
  const liveEngagement = sql`exists (
    select 1 from ${engagementsTable}
    where ${engagementsTable.firmId} = ${evidenceRequestsTable.firmId}
      and ${engagementsTable.clientPartyId} = ${evidenceRequestsTable.clientPartyId}
      and ${engagementsTable.status} in ('open', 'in_progress')
  )`;
  const hasRecipient = sql`exists (
    select 1 from ${membershipsTable}
    where ${membershipsTable.firmId} = ${evidenceRequestsTable.firmId}
      and ((${membershipsTable.role} in ('firm_admin', 'firm_staff')
        and ${membershipsTable.userId} = ${evidenceRequestsTable.ownerId})
      or (${membershipsTable.role} = 'client_user'
        and ${membershipsTable.clientPartyId} = ${evidenceRequestsTable.clientPartyId}))
  )`;
  const eligible = and(
    ...(options.firmId
      ? [eq(evidenceRequestsTable.firmId, options.firmId)]
      : []),
    inArray(evidenceRequestsTable.status, [
      "requested",
      "uploaded",
      "needs_changes",
    ]),
    lt(evidenceRequestsTable.dueAt, end),
    or(
      isNull(evidenceRequestsTable.lastReminderAt),
      lt(evidenceRequestsTable.lastReminderAt, start),
    ),
    enabled,
    liveEngagement,
    hasRecipient,
  );
  const candidates = await runInBypassContext(async () => {
    await boundDatabaseStage(deadline);
    return getDb()
      .select({
        id: evidenceRequestsTable.id,
        firmId: evidenceRequestsTable.firmId,
        clientPartyId: evidenceRequestsTable.clientPartyId,
      })
      .from(evidenceRequestsTable)
      .where(eligible)
      .orderBy(evidenceRequestsTable.dueAt, evidenceRequestsTable.id)
      .limit(batchLimit);
  });

  let claimed = 0;
  for (const candidate of candidates) {
    if (stopped()) break;
    const sent = await runInBypassContext(async () => {
      await boundDatabaseStage(deadline);
      if (
        stopped() ||
        !(await isFeatureEnabled("evidence_hub", candidate.firmId))
      )
        return false;
      // Match the request API lock order; a busy firm waits for a later pass.
      const lock = await getDb().execute<{ acquired: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`evidence:${candidate.firmId}`}, 0)) as acquired`,
      );
      if (!lock.rows[0]?.acquired || stopped()) return false;
      const [request] = await getDb()
        .select()
        .from(evidenceRequestsTable)
        .where(
          and(
            eq(evidenceRequestsTable.id, candidate.id),
            eq(evidenceRequestsTable.firmId, candidate.firmId),
            eq(evidenceRequestsTable.clientPartyId, candidate.clientPartyId),
            eligible,
          ),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      if (!request?.dueAt || stopped()) return false;
      const [engagement] = await getDb()
        .select({ id: engagementsTable.id })
        .from(engagementsTable)
        .where(
          and(
            eq(engagementsTable.firmId, request.firmId),
            eq(engagementsTable.clientPartyId, request.clientPartyId),
            inArray(engagementsTable.status, ["open", "in_progress"]),
          ),
        )
        .for("share")
        .limit(1);
      if (!engagement) return false;
      const [owner] = await getDb()
        .select({ userId: membershipsTable.userId })
        .from(membershipsTable)
        .where(
          and(
            eq(membershipsTable.firmId, request.firmId),
            eq(membershipsTable.userId, request.ownerId),
            inArray(membershipsTable.role, ["firm_admin", "firm_staff"]),
          ),
        )
        .for("share")
        .limit(1);
      const [client] = await getDb()
        .select({ id: membershipsTable.id })
        .from(membershipsTable)
        .where(
          and(
            eq(membershipsTable.firmId, request.firmId),
            eq(membershipsTable.clientPartyId, request.clientPartyId),
            eq(membershipsTable.role, "client_user"),
          ),
        )
        .for("share")
        .limit(1);
      if ((!owner && !client) || stopped()) return false;
      // Fixed copy and opaque request links only; never filenames or descriptions.
      const notification = {
        channel: "in_app" as const,
        templateKey:
          request.dueAt.getTime() < now.getTime()
            ? "document_request_overdue"
            : "document_request_due",
        entityType: "evidence_request",
        entityId: request.id,
        status: "delivered" as const,
        createdAt: now,
      };
      await getDb()
        .insert(messagesTable)
        .values([
          ...(owner
            ? [
                {
                  ...notification,
                  recipientRef: pointerEntityRef("usr", owner.userId),
                  recipientUserId: owner.userId,
                },
              ]
            : []),
          ...(client
            ? [
                {
                  ...notification,
                  recipientRef: recipientRefFor(request.clientPartyId),
                  recipientPartyId: request.clientPartyId,
                },
              ]
            : []),
        ]);
      await getDb().insert(evidenceEventsTable).values({
        firmId: request.firmId,
        requestId: request.id,
        actorId: null,
        action: "reminder_sent",
        createdAt: now,
      });
      await getDb()
        .update(evidenceRequestsTable)
        .set({ lastReminderAt: now, updatedAt: request.updatedAt })
        .where(
          and(
            eq(evidenceRequestsTable.id, request.id),
            eq(evidenceRequestsTable.firmId, request.firmId),
            eq(evidenceRequestsTable.clientPartyId, request.clientPartyId),
          ),
        );
      await appendAudit({
        firmId: request.firmId,
        action: "evidence.reminder_sent",
        entityType: "evidence_request",
        entityId: request.id,
        after: {
          date,
          recipientCount: Number(Boolean(owner)) + Number(Boolean(client)),
        },
      });
      return true;
    });
    if (sent) claimed++;
  }
  return claimed;
}
