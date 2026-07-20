import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  auditEventsTable,
  type AuditEvent,
} from "@workspace/db";

// The newest audit event for an (action, entityId) pair — the shape every
// ledger-dedup watch test asserts on (the watches append exactly one alert
// per entity, so "the latest event" is "the alert").
export async function latestAuditEvent(
  action: string,
  entityId: string,
): Promise<AuditEvent | undefined> {
  const [event] = await runInBypassContext(() =>
    getDb()
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, action),
          eq(auditEventsTable.entityId, entityId),
        ),
      )
      .orderBy(desc(auditEventsTable.seq))
      .limit(1),
  );
  return event;
}
