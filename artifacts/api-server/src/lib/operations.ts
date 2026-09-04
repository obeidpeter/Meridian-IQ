import { sql } from "drizzle-orm";
import { getDb, runInBypassContext } from "@workspace/db";

export type OperationalHeartbeatKey =
  | "scheduled_work"
  | "backup"
  | "restore_drill";

function cleanError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/g, " ").slice(0, 500);
}

export async function markOperationStarted(
  key: OperationalHeartbeatKey,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await runInBypassContext(async () => {
    await getDb().execute(sql`
      INSERT INTO operational_heartbeats
        (key, last_started_at, metadata, updated_at)
      VALUES (${key}, now(), ${JSON.stringify(metadata)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET
        last_started_at = excluded.last_started_at,
        metadata = excluded.metadata,
        updated_at = now()
    `);
  });
}

export async function markOperationSucceeded(
  key: OperationalHeartbeatKey,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await runInBypassContext(async () => {
    await getDb().execute(sql`
      INSERT INTO operational_heartbeats
        (key, last_started_at, last_succeeded_at, last_error, metadata, updated_at)
      VALUES (${key}, now(), now(), NULL, ${JSON.stringify(metadata)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET
        last_succeeded_at = excluded.last_succeeded_at,
        last_error = NULL,
        metadata = excluded.metadata,
        updated_at = now()
    `);
  });
}

export async function markOperationFailed(
  key: OperationalHeartbeatKey,
  error: unknown,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await runInBypassContext(async () => {
    await getDb().execute(sql`
      INSERT INTO operational_heartbeats
        (key, last_started_at, last_failed_at, last_error, metadata, updated_at)
      VALUES (${key}, now(), now(), ${cleanError(error)}, ${JSON.stringify(metadata)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET
        last_failed_at = excluded.last_failed_at,
        last_error = excluded.last_error,
        metadata = excluded.metadata,
        updated_at = now()
    `);
  });
}
