// Migration 0044 - one account may have only one live recovery credential.
// Keep the newest historical pending row before adding the partial unique
// index so old databases can adopt the invariant without a failed deploy.

const up = `
WITH ranked_pending AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id
           ORDER BY created_at DESC, id DESC
         ) AS position
  FROM password_resets
  WHERE status = 'pending'
)
UPDATE password_resets r
SET status = 'revoked'
FROM ranked_pending p
WHERE r.id = p.id
  AND p.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS password_resets_one_pending_per_user_uq
  ON password_resets (user_id)
  WHERE status = 'pending';
`;

const down = `
DROP INDEX IF EXISTS password_resets_one_pending_per_user_uq;
`;

export const migration0044 = {
  version: 44,
  name: "password_reset_concurrency_guardrail",
  up,
  down,
};
