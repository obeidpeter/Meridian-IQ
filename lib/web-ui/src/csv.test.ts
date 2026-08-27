import { describe, expect, test } from "vitest";
import { csvCell, parseCsvTable } from "./csv";

describe("parseCsvTable", () => {
  test("splits plain rows and cells", () => {
    expect(parseCsvTable("a,b,c\nd,e,f")).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  test("keeps commas inside quoted fields", () => {
    expect(parseCsvTable('a,b\n"x, y",z')[1]).toEqual(["x, y", "z"]);
  });

  test("unescapes doubled quotes inside a quoted field", () => {
    expect(parseCsvTable('a\n"say ""go"""')[1]).toEqual(['say "go"']);
  });

  test("keeps a quoted embedded newline inside one cell", () => {
    expect(parseCsvTable('a,b\n"line one\nline two",z')[1]).toEqual([
      "line one\nline two",
      "z",
    ]);
  });

  test("handles CRLF endings and drops all-blank / separator-only rows", () => {
    expect(parseCsvTable("a,b\r\n,\r\n   , \r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("keeps the final row when the text has no trailing newline", () => {
    expect(parseCsvTable("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("csvCell", () => {
  test("passes a simple value through unquoted", () => {
    expect(csvCell("INV-1")).toBe("INV-1");
  });

  test("quotes a value containing a comma", () => {
    expect(csvCell("Adaeze Foods, Ltd")).toBe('"Adaeze Foods, Ltd"');
  });

  test("quotes and escapes embedded quotes", () => {
    expect(csvCell('say "go"')).toBe('"say ""go"""');
  });

  test("quotes a value containing a newline", () => {
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });
});
