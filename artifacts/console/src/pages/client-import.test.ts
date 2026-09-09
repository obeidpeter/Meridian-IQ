import { describe, expect, test } from "vitest";
import { importResultsCsv } from "./client-import";

describe("importResultsCsv", () => {
  test("one line per result row with the source name and joined field errors", () => {
    const csv = importResultsCsv(
      [
        { rowNumber: 1, status: "created" },
        {
          rowNumber: 2,
          status: "invalid",
          errors: [{ field: "tin", message: "TIN must be 14 digits" }],
        },
      ],
      [{ legalName: "Adaeze Foods Ltd" }, { legalName: 'Kano "Best" Grains' }],
    );
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe('"row","legalName","status","errors"');
    expect(lines[1]).toBe('"1","Adaeze Foods Ltd","created",""');
    expect(lines[2]).toBe(
      '"2","Kano ""Best"" Grains","invalid","tin: TIN must be 14 digits"',
    );
  });
});
