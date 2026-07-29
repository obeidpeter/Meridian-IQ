import { describe, expect, test } from "vitest";
import {
  sortVatPositionRows,
  vatPositionsMonthLabel,
} from "./vat-positions-card";
import type { FirmVatPositionRow } from "@workspace/api-client-react";

// Firm VAT positions: table order and month labelling. The numbers
// themselves come from the server verbatim — only the presentation is ours
// to get right.

function row(over: Partial<FirmVatPositionRow> = {}): FirmVatPositionRow {
  return {
    clientPartyId: "cp-1",
    clientName: "Adaeze Foods",
    outputVat: "100.00",
    inputVat: "20.00",
    inputVatVerified: "10.00",
    netVat: "80.00",
    defensibleNetVat: "90.00",
    ...over,
  };
}

describe("sortVatPositionRows", () => {
  test("largest net liability first — the filings needing attention lead", () => {
    const sorted = sortVatPositionRows([
      row({ clientPartyId: "cp-small", netVat: "50.00" }),
      row({ clientPartyId: "cp-big", netVat: "5000.00" }),
      row({ clientPartyId: "cp-credit", netVat: "-120.00" }),
    ]);
    expect(sorted.map((r) => r.clientPartyId)).toEqual([
      "cp-big",
      "cp-small",
      "cp-credit",
    ]);
  });

  test("equal net positions fall back to the client name", () => {
    const sorted = sortVatPositionRows([
      row({ clientPartyId: "cp-z", clientName: "Zenith Retail", netVat: "80.00" }),
      row({ clientPartyId: "cp-a", clientName: "Adaeze Foods", netVat: "80.00" }),
    ]);
    expect(sorted.map((r) => r.clientPartyId)).toEqual(["cp-a", "cp-z"]);
  });

  test("does not mutate the server's row order", () => {
    const rows = [
      row({ clientPartyId: "cp-1", netVat: "1.00" }),
      row({ clientPartyId: "cp-2", netVat: "2.00" }),
    ];
    sortVatPositionRows(rows);
    expect(rows.map((r) => r.clientPartyId)).toEqual(["cp-1", "cp-2"]);
  });
});

describe("vatPositionsMonthLabel", () => {
  test("names a Lagos month start", () => {
    expect(vatPositionsMonthLabel("2026-07-01")).toBe("July 2026");
    expect(vatPositionsMonthLabel("2026-01-01")).toBe("January 2026");
  });

  test("an off-contract month falls back to the raw token", () => {
    expect(vatPositionsMonthLabel("2026-13-01")).toBe("13 2026");
  });
});
