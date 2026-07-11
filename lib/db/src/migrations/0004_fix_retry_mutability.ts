// Migration 0004 — align DB immutability guardrails with the invoice
// lifecycle's mutability rule (fix-and-retry).
//
// Migration 0001 froze invoice financial content and lines for every non-draft
// status, but the application lifecycle (assertMutableContent) deliberately
// treats draft, validated AND failed as content-mutable: a failed invoice was
// rejected by the rail and never stamped, so the user must be able to correct
// the implicated data before retrying (failed → submitted). Validated is
// mutable because an edit reverts it to draft for re-validation. The hard
// guardrail remains for submitted/stamped/confirmed/settled/cancelled/credited.
// Idempotent (CREATE OR REPLACE); `down` restores the 0001 draft-only rule.

const MUTABLE = `('draft', 'validated', 'failed')`;

const up = `
CREATE OR REPLACE FUNCTION meridian_enforce_invoice_immutability() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_purge', true) = 'on'
       AND OLD.legal_hold = false
       AND OLD.retention_until IS NOT NULL
       AND OLD.retention_until <= now()::date THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'invoice_delete_blocked: invoice % is under retention or legal hold', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ${MUTABLE} THEN
    IF NEW.supplier_party_id <> OLD.supplier_party_id
       OR NEW.buyer_party_id <> OLD.buyer_party_id
       OR NEW.invoice_number <> OLD.invoice_number
       OR NEW.currency <> OLD.currency
       OR NEW.issue_date <> OLD.issue_date
       OR NEW.kind <> OLD.kind
       OR NEW.category <> OLD.category
       OR NEW.subtotal <> OLD.subtotal
       OR NEW.vat_total <> OLD.vat_total
       OR NEW.grand_total <> OLD.grand_total THEN
      RAISE EXCEPTION 'immutable_invoice: financial content of invoice % is immutable after submission', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION meridian_enforce_line_immutability() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF st IS NOT NULL AND st NOT IN ${MUTABLE} THEN
    IF TG_OP = 'DELETE' AND current_setting('app.allow_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'immutable_invoice_line: lines are immutable after submission'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
`;

const down = `
CREATE OR REPLACE FUNCTION meridian_enforce_invoice_immutability() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_purge', true) = 'on'
       AND OLD.legal_hold = false
       AND OLD.retention_until IS NOT NULL
       AND OLD.retention_until <= now()::date THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'invoice_delete_blocked: invoice % is under retention or legal hold', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.supplier_party_id <> OLD.supplier_party_id
       OR NEW.buyer_party_id <> OLD.buyer_party_id
       OR NEW.invoice_number <> OLD.invoice_number
       OR NEW.currency <> OLD.currency
       OR NEW.issue_date <> OLD.issue_date
       OR NEW.kind <> OLD.kind
       OR NEW.category <> OLD.category
       OR NEW.subtotal <> OLD.subtotal
       OR NEW.vat_total <> OLD.vat_total
       OR NEW.grand_total <> OLD.grand_total THEN
      RAISE EXCEPTION 'immutable_invoice: financial content of invoice % is immutable after submission', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION meridian_enforce_line_immutability() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    IF TG_OP = 'DELETE' AND current_setting('app.allow_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'immutable_invoice_line: lines are immutable after submission'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
`;

export const migration0004 = {
  version: 4,
  name: "fix_retry_mutability",
  up,
  down,
};
