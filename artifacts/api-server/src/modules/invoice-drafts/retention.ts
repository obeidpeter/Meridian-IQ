import { sql } from "drizzle-orm";
import { getDb, runInBypassContext } from "@workspace/db";

/** One bounded batch; retain identity/revision tombstones against late writes. */
export async function sweepExpiredInvoiceDraftContent(): Promise<number> {
  return runInBypassContext(async () => {
    const result = await getDb().execute<{ id: string }>(sql`
      WITH expired AS (
        SELECT firm_id, user_id, client_party_id, id FROM invoice_drafts
        WHERE content <> '{}'::jsonb AND (expires_at <= now() OR deleted_at IS NOT NULL)
        ORDER BY expires_at, id
        LIMIT 1000
        FOR UPDATE SKIP LOCKED
      )
      UPDATE invoice_drafts AS d
      SET content = '{}'::jsonb, deleted_at = coalesce(d.deleted_at, now())
      FROM expired AS e
      WHERE d.firm_id = e.firm_id AND d.user_id = e.user_id
        AND d.client_party_id = e.client_party_id AND d.id = e.id
      RETURNING d.id
    `);
    return result.rows.length;
  });
}
