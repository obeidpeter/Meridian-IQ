export const migration0050 = {
  version: 50,
  name: "invoice_content_revisions",
  up: `
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS content_revision integer NOT NULL DEFAULT 1;
ALTER TABLE invoice_approvals ADD COLUMN IF NOT EXISTS content_revision integer;
-- Legacy approvals cannot prove which content the reviewer saw. Preserve the
-- evidence, but require a fresh approval before the next guarded submission.
UPDATE invoice_approvals SET revoked_at = now()
 WHERE content_revision IS NULL AND revoked_at IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_content_revision_positive') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoice_content_revision_positive CHECK (content_revision > 0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS invoice_approvals_live_revision_idx
 ON invoice_approvals(invoice_id, content_revision) WHERE revoked_at IS NULL;
-- Fail for review if legacy duplicates exist; never silently remove invoice data.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_lines_number_uidx ON invoice_lines(invoice_id, line_no);
`,
  down: "SELECT 1; -- Preserve reviewed revisions and approval evidence during application rollback.",
};
