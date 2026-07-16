import { test } from "node:test";
import assert from "node:assert/strict";
import type { InvoiceDraftResult } from "@workspace/api-client-react";
import { applyDraftProposal, fractionToPercent } from "./draft-voice";

// Voice drafting (idea #7): the mapper only translates dialects and applies
// what the picker can honour — it never invents values and never applies a
// buyer the form cannot select.

test("fractionToPercent translates the API dialect to the form's", () => {
  assert.equal(fractionToPercent("0.075"), "7.5");
  assert.equal(fractionToPercent("0"), "0");
  assert.equal(fractionToPercent(null), "7.5");
  assert.equal(fractionToPercent(""), "7.5");
  assert.equal(fractionToPercent("1.5"), "7.5", "out-of-range falls back");
});

function result(over: Partial<InvoiceDraftResult["proposal"]>): InvoiceDraftResult {
  return {
    proposal: {
      buyerName: "Adaeze Foods",
      buyerTin: null,
      invoiceNumber: null,
      issueDate: null,
      dueDate: null,
      currency: "NGN",
      lines: [
        {
          description: "June deliveries",
          quantity: "1",
          unitPrice: "150000",
          vatRate: "0.075",
        },
      ],
      ...over,
    },
    buyerSuggestions: [
      {
        partyId: "buyer-1",
        legalName: "Adaeze Foods Ltd",
        tin: null,
        type: "buyer",
        confidence: 0.6,
        tinScore: 0,
        nameScore: 1,
      },
    ],
    model: "m",
    promptVersion: "draft-invoice.v1",
  };
}

test("applies the suggestion only when the picker offers that buyer", () => {
  const matched = applyDraftProposal(result({}), ["buyer-1", "buyer-2"], "v");
  assert.equal(matched.buyerPartyId, "buyer-1");
  assert.equal(matched.lines?.length, 1);
  assert.equal(matched.lines?.[0].vatRate, "7.5");
  assert.equal(matched.lines?.[0].unitPrice, "150000");
  assert.equal(matched.lines?.[0].key, "v0");

  const unmatched = applyDraftProposal(result({}), ["someone-else"], "v");
  assert.equal(unmatched.buyerPartyId, null);
  assert.equal(unmatched.buyerNameRead, "Adaeze Foods");
});

test("an empty proposal keeps the form's existing lines", () => {
  const applied = applyDraftProposal(result({ lines: [] }), [], "v");
  assert.equal(applied.lines, null);
});
