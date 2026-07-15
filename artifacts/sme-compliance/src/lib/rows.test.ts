import { describe, expect, it } from "vitest";
import { idMap, scopedToSupplier } from "./rows";

describe("idMap", () => {
  it("maps ids to display values", () => {
    const map = idMap(
      [
        { id: "a", legalName: "Acme Ltd" },
        { id: "b", legalName: "Bode & Co" },
      ],
      (p) => p.id,
      (p) => p.legalName,
    );
    expect(map.get("a")).toBe("Acme Ltd");
    expect(map.get("b")).toBe("Bode & Co");
    expect(map.get("missing")).toBeUndefined();
  });

  it("returns an empty map for null/undefined lists", () => {
    expect(idMap(null, () => "x", () => "y").size).toBe(0);
    expect(idMap(undefined, () => "x", () => "y").size).toBe(0);
  });

  it("lets later entries win on duplicate ids", () => {
    const map = idMap(
      [
        { id: "a", name: "first" },
        { id: "a", name: "second" },
      ],
      (p) => p.id,
      (p) => p.name,
    );
    expect(map.get("a")).toBe("second");
  });
});

describe("scopedToSupplier", () => {
  const rows = [
    { supplierPartyId: "mine", n: 1 },
    { supplierPartyId: "theirs", n: 2 },
  ];

  it("keeps only the client's own rows when a clientPartyId is set", () => {
    expect(scopedToSupplier(rows, "mine")).toEqual([
      { supplierPartyId: "mine", n: 1 },
    ]);
  });

  it("passes everything through for firm users (no clientPartyId)", () => {
    expect(scopedToSupplier(rows, null)).toEqual(rows);
    expect(scopedToSupplier(rows, undefined)).toEqual(rows);
    expect(scopedToSupplier(rows, "")).toEqual(rows);
  });
});
