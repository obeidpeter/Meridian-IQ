import { test } from "node:test";
import assert from "node:assert/strict";
import {
  proposeMatches,
  scorePair,
  amountScore,
  dateScore,
  type MatchCandidate,
  type MatchableLine,
} from "./matcher.ts";

// SME-07 acceptance: on a fixture book, >= 85% of true matches are proposed.
// The fixture is a synthetic 60-invoice receivables book whose statement lines
// exhibit the mix reconciliation meets in the field: clean narration hits,
// amount-only transfers, fee-shaved near-misses, and unrelated noise.

const BUYERS = [
  "Zenith Retail Group",
  "Sahara Logistics Ltd",
  "Kano Textiles Ltd",
  "Lagos BuildRight Ltd",
];

function isoDate(base: string, plusDays: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10);
}

function buildFixture(): {
  candidates: MatchCandidate[];
  lines: MatchableLine[];
  truth: Map<string, string>; // lineId -> invoiceId
} {
  const candidates: MatchCandidate[] = [];
  const lines: MatchableLine[] = [];
  const truth = new Map<string, string>();

  for (let i = 1; i <= 60; i++) {
    const buyer = BUYERS[i % BUYERS.length];
    const total = 50_000 + i * 13_750;
    const issueDate = isoDate("2027-01-01", i % 25);
    const invoice: MatchCandidate = {
      invoiceId: `inv-${i}`,
      invoiceNumber: `INV-${1000 + i}`,
      counterpartyName: buyer,
      orientation: "receivable",
      grandTotal: total,
      issueDate,
      dueDate: isoDate(issueDate, 30),
    };
    candidates.push(invoice);

    const lineId = `line-${i}`;
    truth.set(lineId, invoice.invoiceId);
    if (i % 10 < 6) {
      // 60%: clean transfer — exact amount, invoice number in narration.
      lines.push({
        lineId,
        valueDate: isoDate(issueDate, 14),
        amount: total,
        direction: "credit",
        narration: `NIP TRF ${buyer.toUpperCase()}/INV-${1000 + i}`,
        counterpartyRef: null,
      });
    } else if (i % 10 < 8) {
      // 20%: amount + date only — bank truncated the narration.
      lines.push({
        lineId,
        valueDate: isoDate(issueDate, 7),
        amount: total,
        direction: "credit",
        narration: "TRANSFER RECEIVED",
        counterpartyRef: null,
      });
    } else if (i % 10 === 8) {
      // 10%: fee-shaved near-miss with the buyer name present.
      lines.push({
        lineId,
        valueDate: isoDate(issueDate, 21),
        amount: Math.round(total * 0.9895 * 100) / 100,
        direction: "credit",
        narration: `TRF FROM ${buyer.toUpperCase()}`,
        counterpartyRef: null,
      });
    } else {
      // 10%: reference hit with a 1.5% partial shortfall.
      lines.push({
        lineId,
        valueDate: isoDate(issueDate, 28),
        amount: Math.round(total * 0.985 * 100) / 100,
        direction: "credit",
        narration: `PART PAYMENT INV-${1000 + i}`,
        counterpartyRef: `REF-${1000 + i}`,
      });
    }
  }

  // Noise: debits and unrelated credits that must not create false certainty.
  lines.push(
    {
      lineId: "noise-1",
      valueDate: "2027-02-02",
      amount: 25_000,
      direction: "debit",
      narration: "ATM WITHDRAWAL",
      counterpartyRef: null,
    },
    {
      lineId: "noise-2",
      valueDate: "2027-02-03",
      amount: 123.45,
      direction: "credit",
      narration: "INTEREST CAPITALISED",
      counterpartyRef: null,
    },
  );
  return { candidates, lines, truth };
}

test("SME-07: >= 85% of true matches are proposed on the fixture book", () => {
  const { candidates, lines, truth } = buildFixture();
  const proposals = proposeMatches(lines, candidates);
  let hit = 0;
  for (const [lineId, invoiceId] of truth) {
    if (proposals.some((p) => p.lineId === lineId && p.invoiceId === invoiceId)) {
      hit++;
    }
  }
  const rate = hit / truth.size;
  assert.ok(rate >= 0.85, `true-match proposal rate ${rate} below 0.85`);
});

test("debit lines and sub-threshold noise produce no proposals", () => {
  const { candidates, lines } = buildFixture();
  const proposals = proposeMatches(lines, candidates);
  assert.equal(
    proposals.filter((p) => p.lineId.startsWith("noise")).length,
    0,
    "noise lines must not be proposed",
  );
});

test("a clean reference hit outranks an amount-only match", () => {
  const { candidates } = buildFixture();
  const line: MatchableLine = {
    lineId: "l",
    valueDate: "2027-01-20",
    amount: candidates[0].grandTotal,
    direction: "credit",
    narration: `TRF ${candidates[0].invoiceNumber}`,
    counterpartyRef: null,
  };
  const withRef = scorePair(line, candidates[0]);
  const withoutRef = scorePair(
    { ...line, narration: "TRANSFER" },
    candidates[0],
  );
  assert.ok(withRef.confidence > withoutRef.confidence);
  assert.equal(withRef.features.referenceScore, 1);
});

test("proposals are capped at three per line, sorted by confidence", () => {
  // Ten candidates sharing an identical amount: only the top three propose.
  const candidates: MatchCandidate[] = Array.from({ length: 10 }, (_, i) => ({
    invoiceId: `same-${i}`,
    invoiceNumber: `SAME-${9000 + i}`,
    counterpartyName: "Duplicate Buyer Ltd",
    orientation: "receivable",
    grandTotal: 100_000,
    issueDate: "2027-01-10",
    dueDate: null,
  }));
  const proposals = proposeMatches(
    [
      {
        lineId: "l",
        valueDate: "2027-01-15",
        amount: 100_000,
        direction: "credit",
        narration: "TRANSFER",
        counterpartyRef: null,
      },
    ],
    candidates,
  );
  assert.equal(proposals.length, 3);
  for (let i = 1; i < proposals.length; i++) {
    assert.ok(proposals[i - 1].confidence >= proposals[i].confidence);
  }
});

test("amount agreement is necessary evidence: narration alone never proposes", () => {
  const candidate: MatchCandidate = {
    invoiceId: "inv-x",
    invoiceNumber: "INV-7777",
    counterpartyName: "Zenith Retail Group",
    orientation: "receivable",
    grandTotal: 500_000,
    issueDate: "2027-01-01",
    dueDate: null,
  };
  const proposals = proposeMatches(
    [
      {
        lineId: "l",
        valueDate: "2027-01-10",
        amount: 9_999, // 98% off — outside every tolerance band
        direction: "credit",
        narration: "PAYMENT FOR INV-7777 ZENITH RETAIL",
        counterpartyRef: null,
      },
    ],
    [candidate],
  );
  assert.equal(proposals.length, 0);
});

// ---------------------------------------------------------------------------
// Debit lane (payables round): debits pay BILLS, credits settle RECEIVABLES —
// a line only ever scores against candidates of its own orientation.
// ---------------------------------------------------------------------------

const BILL_CANDIDATE: MatchCandidate = {
  invoiceId: "bill-1",
  invoiceNumber: "BILL-2001",
  counterpartyName: "Lagos Packaging Supplies Ltd",
  orientation: "bill",
  grandTotal: 129_000,
  issueDate: "2027-01-05",
  dueDate: "2027-01-19",
};

test("a debit line proposes against a bill candidate, name-scored on the supplier", () => {
  const proposals = proposeMatches(
    [
      {
        lineId: "debit-1",
        valueDate: "2027-01-12",
        amount: 129_000,
        direction: "debit",
        narration: "NIP TRF LAGOS PACKAGING SUPPLIES/BILL-2001",
        counterpartyRef: null,
      },
    ],
    [BILL_CANDIDATE],
  );
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].invoiceId, "bill-1");
  assert.equal(proposals[0].orientation, "bill");
  assert.equal(proposals[0].features.referenceScore, 1);
  assert.ok(
    proposals[0].features.nameScore > 0,
    "the SUPPLIER name in the narration scores the bill",
  );
});

test("credits never propose against bills; debits never propose against receivables", () => {
  const receivable: MatchCandidate = {
    invoiceId: "recv-1",
    invoiceNumber: "INV-5001",
    counterpartyName: "Zenith Retail Group",
    orientation: "receivable",
    grandTotal: 129_000,
    issueDate: "2027-01-05",
    dueDate: null,
  };
  // Identical amounts on both candidates: only the lane decides.
  const credit = proposeMatches(
    [
      {
        lineId: "credit-1",
        valueDate: "2027-01-12",
        amount: 129_000,
        direction: "credit",
        narration: "TRANSFER RECEIVED",
        counterpartyRef: null,
      },
    ],
    [BILL_CANDIDATE, receivable],
  );
  assert.deepEqual(
    credit.map((p) => p.invoiceId),
    ["recv-1"],
    "a credit must only settle receivables",
  );

  const debit = proposeMatches(
    [
      {
        lineId: "debit-2",
        valueDate: "2027-01-12",
        amount: 129_000,
        direction: "debit",
        narration: "OUTWARD TRANSFER",
        counterpartyRef: null,
      },
    ],
    [BILL_CANDIDATE, receivable],
  );
  assert.deepEqual(
    debit.map((p) => p.invoiceId),
    ["bill-1"],
    "a debit must only pay bills",
  );
});

// ---------------------------------------------------------------------------
// WHT short-pay basis (WHT Desk): a receivable candidate carrying expectedWht
// ALSO scores the line against grandTotal − expectedWht and takes the better
// basis, flagging the features when the adjusted basis wins.
// ---------------------------------------------------------------------------

const WHT_CANDIDATE: MatchCandidate = {
  invoiceId: "wht-recv-1",
  invoiceNumber: "INV-8801",
  counterpartyName: "Zenith Retail Group",
  orientation: "receivable",
  grandTotal: 107_500,
  issueDate: "2027-01-05",
  dueDate: null,
  expectedWht: 5_000, // 5% of the 100,000 subtotal
};

test("an exact WHT short-pay scores 1.0 via the adjusted basis and is flagged", () => {
  const line: MatchableLine = {
    lineId: "wht-l1",
    valueDate: "2027-01-20",
    amount: 102_500, // grandTotal − expectedWht, to the kobo
    direction: "credit",
    narration: "TRF INV-8801 ZENITH RETAIL",
    counterpartyRef: null,
  };
  const { features } = scorePair(line, WHT_CANDIDATE);
  assert.equal(features.amountScore, 1);
  assert.equal(features.whtShortPay, true);
  assert.equal(features.whtExpectedAmount, 5_000);

  // The proposal survives the amount-agreement gate and carries the flag.
  const proposals = proposeMatches([line], [WHT_CANDIDATE]);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].features.whtShortPay, true);
});

test("a full-amount payment keeps the plain basis and never carries the flag", () => {
  const line: MatchableLine = {
    lineId: "wht-l2",
    valueDate: "2027-01-20",
    amount: 107_500,
    direction: "credit",
    narration: "TRF INV-8801",
    counterpartyRef: null,
  };
  const { features } = scorePair(line, WHT_CANDIDATE);
  assert.equal(features.amountScore, 1, "the plain basis already scores 1");
  assert.equal(features.whtShortPay, undefined);
  assert.equal(features.whtExpectedAmount, undefined);
});

test("a candidate without expectedWht scores a short-pay line as before", () => {
  const plain: MatchCandidate = { ...WHT_CANDIDATE, expectedWht: undefined };
  const { features } = scorePair(
    {
      lineId: "wht-l3",
      valueDate: "2027-01-20",
      amount: 102_500, // ~4.65% off the grand total — the 0.4 band
      direction: "credit",
      narration: "TRF INV-8801",
      counterpartyRef: null,
    },
    plain,
  );
  assert.equal(features.amountScore, 0.4);
  assert.equal(features.whtShortPay, undefined);
});

test("bill orientation never gets the WHT adjustment", () => {
  const bill: MatchCandidate = {
    ...WHT_CANDIDATE,
    invoiceId: "wht-bill-1",
    orientation: "bill",
  };
  const { features } = scorePair(
    {
      lineId: "wht-l4",
      valueDate: "2027-01-20",
      amount: 102_500,
      direction: "debit",
      narration: "OUTWARD TRF INV-8801",
      counterpartyRef: null,
    },
    bill,
  );
  // The plain basis only: ~4.65% off lands in the 0.4 band, no flag.
  assert.equal(features.amountScore, 0.4);
  assert.equal(features.whtShortPay, undefined);
});

test("scoring bands behave at their edges", () => {
  assert.equal(amountScore(100_000, 100_000), 1);
  assert.equal(amountScore(99_600, 100_000), 1); // 0.4% off
  assert.equal(amountScore(98_500, 100_000), 0.7); // 1.5% off
  assert.equal(amountScore(96_000, 100_000), 0.4); // 4% off
  assert.equal(amountScore(80_000, 100_000), 0);
  assert.equal(dateScore("2027-01-10", "2027-01-10"), 1);
  assert.equal(dateScore("2026-12-20", "2027-01-10"), 0); // paid well before issue
  assert.equal(dateScore(null, "2027-01-10"), 0);
  assert.ok(dateScore("2027-01-25", "2027-01-10") > 0.7);
});
