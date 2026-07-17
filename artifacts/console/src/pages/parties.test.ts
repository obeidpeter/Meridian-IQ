import { describe, expect, it } from "vitest";
import { findDuplicateGroups, normalizeName } from "./parties";
import type { Party } from "@workspace/api-client-react";

// Duplicate-candidate detection (round-6 idea #4 hardening): the name key is
// order-insensitive and suffix-blind, and a name group with two DIFFERENT
// registered TINs is suppressed — different TINs are different taxpayers
// whatever the names say.

const party = (over: Partial<Party>): Party =>
  ({
    id: over.id ?? Math.random().toString(36).slice(2),
    type: "buyer",
    legalName: "X",
    tin: null,
    cacNumber: null,
    tinValidated: false,
    mergedIntoId: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  }) as Party;

describe("normalizeName", () => {
  it("is order-insensitive and suffix-blind", () => {
    expect(normalizeName("Adaeze Foods Ltd")).toBe(
      normalizeName("FOODS, Adaeze!"),
    );
    expect(normalizeName("The Adaeze Foods Company")).toBe(
      normalizeName("adaeze foods"),
    );
    expect(normalizeName("Adaeze Foods")).not.toBe(
      normalizeName("Adaeze Fabrics"),
    );
  });
});

describe("findDuplicateGroups", () => {
  it("groups same-TIN parties and order-scrambled names", () => {
    const groups = findDuplicateGroups([
      party({ id: "a", legalName: "Alpha Ltd", tin: "111" }),
      party({ id: "b", legalName: "Alpha Nigeria", tin: "111" }),
      party({ id: "c", legalName: "Bravo Stores" }),
      party({ id: "d", legalName: "Stores Bravo Ltd" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].reason).toBe("same TIN");
    expect(groups[1].reason).toBe("similar name");
    expect(groups[1].parties.map((p) => p.id).sort()).toEqual(["c", "d"]);
  });

  it("suppresses name groups carrying two different TINs", () => {
    const groups = findDuplicateGroups([
      party({ id: "a", legalName: "Premier Foods Lagos", tin: "222" }),
      party({ id: "b", legalName: "Lagos Premier Foods", tin: "333" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("keeps a name group when only one TIN is present", () => {
    const groups = findDuplicateGroups([
      party({ id: "a", legalName: "Chukwuma Stores", tin: "444" }),
      party({ id: "b", legalName: "Stores Chukwuma" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe("similar name");
  });

  it("ignores merged rows", () => {
    const groups = findDuplicateGroups([
      party({ id: "a", legalName: "Echo Ltd", tin: "555" }),
      party({ id: "b", legalName: "Echo Ltd", tin: "555", mergedIntoId: "a" }),
    ]);
    expect(groups).toHaveLength(0);
  });
});
