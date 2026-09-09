import { describe, expect, test } from "vitest";
import { dockAnswerView, dockErrorMessage } from "./clerk-dock";

describe("dockAnswerView", () => {
  const fact = (key: string) => ({ key, label: key, value: "1" });

  test("a records answer carries the source line and caps facts at six", () => {
    const view = dockAnswerView({
      answered: true,
      proposition: "p",
      citation: "computed from the book",
      dataIntent: "data.overdue",
      dataParams: { client: "Adaeze Foods Ltd" },
      facts: Array.from({ length: 8 }, (_, i) => fact(`f${i}`)),
    });
    expect(view.sourceLine).toBe(
      "From firm records (Adaeze Foods Ltd) · computed from the book",
    );
    expect(view.facts).toHaveLength(6);
    expect(view.hasMore).toBe(true);
  });

  test("a register answer names the approved claim; nothing dropped means no hasMore", () => {
    const view = dockAnswerView({
      answered: true,
      citation: "VAT Act s.15",
      claimKey: "vat.rate",
      claimVersion: 3,
      facts: [fact("a")],
    });
    expect(view.sourceLine).toBe(
      "Source: VAT Act s.15 · approved claim vat.rate v3",
    );
    expect(view.hasMore).toBe(false);
  });

  test("a proposed action or deep link means there is more in the full workspace", () => {
    expect(
      dockAnswerView({ answered: true, sections: [{ facts: [], action: {} }] })
        .hasMore,
    ).toBe(true);
    expect(dockAnswerView({ answered: true, links: [{}] }).hasMore).toBe(true);
  });
});

describe("dockErrorMessage", () => {
  test("the kill switch and the monthly allowance each explain themselves", () => {
    const err = (status: number) =>
      Object.assign(new Error(`HTTP ${status}`), {
        status,
        response: { status },
      });
    expect(dockErrorMessage(err(503))).toContain("switched off");
    expect(dockErrorMessage(err(429))).toContain("allowance");
  });

  test("anything else relays the server's words and says nothing changed", () => {
    expect(dockErrorMessage(new Error("boom"))).toContain(
      "Nothing was changed.",
    );
  });
});
