import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  invoiceLinesTable,
} from "@workspace/db";
import {
  aggregateLineItems,
  itemKey,
  linePriceIssues,
  listLineItemSuggestions,
} from "./line-items.ts";
import { lagosDateString } from "../../lib/lagos-time.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Line-item memory (round-4 idea #1). Pinned invariants:
//  - the item key treats word order/case/punctuation as noise, so "Bag of
//  Cement 50kg" and "50KG CEMENT BAG" share one habit;
//  - only habits (2+ occurrences with usable prices) are suggested, newest
//  description wins, the VAT rate is the MODE (never an average between the
//  two lawful rates);
//  - price-deviation flags need MORE history (3+) and a wide band (×4), and
//  quote only this supplier's own numbers;
//  - mining is scoped to the client's own live invoices in one firm.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const buyer = randomUUID();

const daysAgo = (n: number) =>
  lagosDateString(new Date(Date.now() - n * 86_400_000));

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Items Firm A ${SALT}` },
    { id: firmB, name: `Items Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `Items Client A ${SALT}` },
    { id: clientB, type: "client_business", legalName: `Items Client B ${SALT}` },
    { id: buyer, type: "buyer", legalName: `Items Buyer ${SALT}` },
  ]);

  const mk = async (over: {
    firmId?: string;
    supplier?: string;
    n: string;
    issueDate: string;
    status?: string;
    lines: Array<{ description: string; unitPrice: string; vatRate: string }>;
  }) => {
    const id = randomUUID();
    await db.insert(invoicesTable).values({
      id,
      firmId: over.firmId ?? firmA,
      supplierPartyId: over.supplier ?? clientA,
      buyerPartyId: buyer,
      invoiceNumber: over.n,
      issueDate: over.issueDate,
      status: (over.status ?? "stamped") as never,
    });
    await db.insert(invoiceLinesTable).values(
      over.lines.map((l, i) => ({
        invoiceId: id,
        lineNo: i + 1,
        description: l.description,
        quantity: "1",
        unitPrice: l.unitPrice,
        vatRate: l.vatRate,
        lineExtension: l.unitPrice,
      })),
    );
  };

  // Client A: a monthly retainer habit under drifting descriptions.
  await mk({
    n: `LI-1-${SALT}`,
    issueDate: daysAgo(90),
    lines: [{ description: `Retainer ${SALT} monthly`, unitPrice: "100000", vatRate: "0.075" }],
  });
  await mk({
    n: `LI-2-${SALT}`,
    issueDate: daysAgo(60),
    lines: [{ description: `Monthly retainer ${SALT}`, unitPrice: "110000", vatRate: "0.075" }],
  });
  await mk({
    n: `LI-3-${SALT}`,
    issueDate: daysAgo(30),
    lines: [
      { description: `MONTHLY RETAINER ${SALT}`, unitPrice: "105000", vatRate: "0.075" },
      // A one-off line: no habit, never suggested.
      { description: `One-off filing ${SALT}`, unitPrice: "25000", vatRate: "0.075" },
    ],
  });
  // A cancelled invoice's lines are dead paper.
  await mk({
    n: `LI-x-${SALT}`,
    issueDate: daysAgo(20),
    status: "cancelled",
    lines: [{ description: `Monthly retainer ${SALT}`, unitPrice: "999999", vatRate: "0.075" }],
  });
  // Client B (same firm): its habit must not leak into client A's catalogue.
  await mk({
    supplier: clientB,
    n: `LI-b1-${SALT}`,
    issueDate: daysAgo(40),
    lines: [{ description: `Sibling item ${SALT}`, unitPrice: "5000", vatRate: "0" }],
  });
  await mk({
    supplier: clientB,
    n: `LI-b2-${SALT}`,
    issueDate: daysAgo(10),
    lines: [{ description: `Sibling item ${SALT}`, unitPrice: "5000", vatRate: "0" }],
  });
});

test("itemKey: order, case and punctuation are noise; short noise drops", () => {
  assert.equal(itemKey("Bag of Cement 50kg"), itemKey("50KG CEMENT BAG!"));
  assert.equal(itemKey("a b"), null, "nothing meaningful left");
  assert.equal(itemKey(null), null);
  assert.notEqual(itemKey("Cement bag"), itemKey("Cement block"));
});

test("aggregateLineItems: habits only, newest description, median price, modal rate", () => {
  const items = aggregateLineItems([
    { description: "Web hosting", unitPrice: 100, vatRate: 0.075, issueDate: "2026-05-01" },
    { description: "HOSTING WEB", unitPrice: 300, vatRate: 0.075, issueDate: "2026-06-01" },
    { description: "Web hosting renewal", unitPrice: 200, vatRate: 0, issueDate: "2026-06-15" },
    { description: "Once only", unitPrice: 50, vatRate: 0, issueDate: "2026-06-10" },
  ]);
  assert.equal(items.length, 1, "the one-off is not a habit");
  assert.equal(items[0].description, "HOSTING WEB", "newest literal wins");
  assert.equal(items[0].count, 2);
  assert.equal(items[0].medianUnitPrice, "200");
  assert.equal(items[0].vatRate, "0.075", "mode, not an average");
});

test("linePriceIssues: flags a far-off price, stays quiet in band or thin history", () => {
  const items = [
    {
      key: itemKey("Monthly retainer")!,
      description: "Monthly retainer",
      count: 3,
      medianUnitPrice: "100000",
      vatRate: "0.075",
      lastUsed: "2026-06-01",
    },
    {
      key: itemKey("Rare thing")!,
      description: "Rare thing",
      count: 2, // below the price-check floor
      medianUnitPrice: "1000",
      vatRate: "0",
      lastUsed: "2026-06-01",
    },
  ];
  const flagged = linePriceIssues(
    [
      { description: "retainer monthly", unitPrice: "1,000,000" }, // 10× median
      { description: "Monthly retainer", unitPrice: "120000" }, // in band
      { description: "Rare thing", unitPrice: "900000" }, // thin history
      { description: "Unknown item", unitPrice: "5" }, // no habit
    ],
    items,
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].lineNo, 1);
  assert.ok(flagged[0].message.includes("100000"), "quotes the usual price");
});

test("listLineItemSuggestions: own habits only — no dead paper, no siblings, no other firms", async () => {
  const items = await listLineItemSuggestions(firmA, clientA);
  const retainer = items.find((i) => i.key === itemKey(`Monthly retainer ${SALT}`));
  assert.ok(retainer, "the retainer habit is found across drifted descriptions");
  assert.equal(retainer.count, 3, "the cancelled invoice's line is excluded");
  assert.equal(retainer.medianUnitPrice, "105000");
  assert.equal(retainer.vatRate, "0.075");
  assert.equal(retainer.description, `MONTHLY RETAINER ${SALT}`, "newest literal");
  assert.equal(
    items.find((i) => i.key === itemKey(`One-off filing ${SALT}`)),
    undefined,
    "a single occurrence is not a habit",
  );
  assert.equal(
    items.find((i) => i.key === itemKey(`Sibling item ${SALT}`)),
    undefined,
    "another client's habit never leaks in",
  );
  const otherFirm = await listLineItemSuggestions(firmB, clientA);
  assert.equal(
    otherFirm.find((i) => i.key === itemKey(`Monthly retainer ${SALT}`)),
    undefined,
    "the firm filter holds",
  );
});
