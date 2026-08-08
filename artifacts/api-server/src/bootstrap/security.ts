import { pool } from "@workspace/db";
import { PRODUCTION_DEMO_EMAILS } from "../modules/auth/session";

// A published database can be copied from a development environment. Remove
// every authentication path from the historical demo identities and revoke
// their existing first-party sessions before the instance becomes ready.
export async function disableProductionDemoIdentities(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE users
        SET password_hash = NULL,
            clerk_user_id = NULL,
            session_epoch = session_epoch + 1,
            updated_at = now()
      WHERE email = ANY($1::text[])
        AND (password_hash IS NOT NULL OR clerk_user_id IS NOT NULL)
      RETURNING id`,
    [[...PRODUCTION_DEMO_EMAILS]],
  );
  return rows.length;
}
