import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DraftContent, DraftWriteBody } from "./contract.ts";
import { migration0052 } from "../../../../../lib/db/src/migrations/0052_invoice_drafts.ts";

const content = {
  invoiceNumber: "",
  buyerPartyId: "",
  issueDate: "",
  dueDate: "",
  currency: "NGN",
  fxRateToNgn: "",
  whtCategory: "",
  lines: [{ description: "", quantity: "", unitPrice: "", vatRate: "" }],
};
test("unfinished drafts validate without pretending they are valid invoice commands", () => {
  assert.deepEqual(DraftContent.parse(content), content);
  assert.equal(
    DraftWriteBody.safeParse({
      clientPartyId: randomUUID(),
      expectedRevision: 0,
      writeId: randomUUID(),
      draft: content,
    }).success,
    true,
  );
});
test("draft writes require explicit revision, immutable write identity and bounded content", () => {
  const input = {
    clientPartyId: randomUUID(),
    expectedRevision: 0,
    writeId: randomUUID(),
    draft: content,
  };
  for (const patch of [
    { expectedRevision: -1 },
    { expectedRevision: 1.1 },
    { writeId: "" },
    { expectedRevision: undefined },
    { userId: "spoof" },
    { draft: { ...content, buyerPartyId: "bad" } },
    {
      draft: {
        ...content,
        lines: Array.from({ length: 501 }, () => content.lines[0]),
      },
    },
  ]) {
    assert.equal(
      DraftWriteBody.safeParse({ ...input, ...patch }).success,
      false,
    );
  }
});
test("migration grants runtime DML, applies actor/client RLS and preserves data on rollback", () => {
  assert.match(
    migration0052.up,
    /GRANT SELECT, INSERT, UPDATE ON invoice_drafts TO meridian_app/,
  );
  assert.match(migration0052.up, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration0052.up, /app\.invoice_draft_user_id/);
  assert.match(migration0052.up, /app\.invoice_draft_client_id/);
  assert.doesNotMatch(
    migration0052.down,
    /DROP|DELETE|TRUNCATE|DISABLE|NO FORCE/,
  );
});
