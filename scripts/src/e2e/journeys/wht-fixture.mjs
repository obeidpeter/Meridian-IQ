import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { psql } from "../../ops/common.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Incoming bills cannot be created through the outgoing-invoice API on behalf
// of an unengaged vendor. Seed only the document; the journey assigns WHT by API.
export function seedIncomingWhtBill(
  { sourceBillId, clientPartyId, period },
  { env = process.env, query = psql, newId = randomUUID } = {},
) {
  assert.equal(
    env.E2E_DATABASE_DISPOSABLE,
    "1",
    "WHT fixture requires E2E_DATABASE_DISPOSABLE=1 on a scratch database",
  );
  assert.ok(
    typeof env.DATABASE_URL === "string" && env.DATABASE_URL.trim(),
    "scratch DATABASE_URL required",
  );
  assert.notEqual(
    env.NODE_ENV,
    "production",
    "WHT fixture cannot run in production",
  );
  for (const [name, value] of Object.entries({ sourceBillId, clientPartyId })) {
    assert.ok(
      typeof value === "string" && UUID.test(value),
      `${name} must be a UUID`,
    );
  }
  assert.ok(
    typeof period === "string" &&
      /^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/.test(period),
    "period must be YYYY-MM",
  );
  const invoiceId = newId();
  assert.ok(
    typeof invoiceId === "string" && UUID.test(invoiceId),
    "fixture invoiceId must be a UUID",
  );
  const invoiceNumber = `WHT-${invoiceId}`;

  // The source orientation and engagements are checked inside the same atomic
  // insert. A missing/changed source must fail, never leave a header-only bill.
  query(
    env.DATABASE_URL,
    `BEGIN;
SET LOCAL app.bypass = 'on';
DO $wht_fixture$
DECLARE inserted_count integer;
BEGIN
  INSERT INTO invoices (
    id, firm_id, supplier_party_id, buyer_party_id, kind, category,
    invoice_number, currency, issue_date, status, wht_category,
    subtotal, vat_total, grand_total
  )
  SELECT '${invoiceId}'::uuid, source.firm_id, source.supplier_party_id,
    source.buyer_party_id, 'invoice', 'b2b', '${invoiceNumber}', 'NGN',
    '${period}-15'::date, 'draft', NULL, 200000, 15000, 215000
  FROM invoices source
  WHERE source.id = '${sourceBillId}'::uuid
    AND source.invoice_number = 'BILL-2001'
    AND source.kind = 'invoice'
    AND source.buyer_party_id = '${clientPartyId}'::uuid
    AND source.supplier_party_id <> source.buyer_party_id
    AND EXISTS (
      SELECT 1 FROM engagements e WHERE e.firm_id = source.firm_id
        AND e.client_party_id = source.buyer_party_id AND e.status <> 'archived'
    )
    AND NOT EXISTS (
      SELECT 1 FROM engagements e WHERE e.firm_id = source.firm_id
        AND e.client_party_id = source.supplier_party_id
    );
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION 'WHT fixture requires the seeded incoming bill with an engaged buyer and unengaged vendor';
  END IF;
  INSERT INTO invoice_lines (
    invoice_id, line_no, description, quantity, unit_price, vat_rate,
    line_extension, vat_amount
  ) VALUES (
    '${invoiceId}'::uuid, 1, 'WHT probe professional services',
    1, 200000, 0.075, 200000, 15000
  );
END;
$wht_fixture$;
COMMIT;`,
  );
  return { invoiceId, invoiceNumber };
}
