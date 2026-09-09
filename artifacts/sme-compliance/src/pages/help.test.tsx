// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Help, HELP_TOPICS } from "./help";
import { HELP_TOPICS as SHARED_HELP_TOPICS } from "@/lib/help-topics";

afterEach(cleanup);

// The command menu and the contextual links deep-link by topic id, so the
// topic list is a small contract: unique ids, plain-language content, and a
// rendered anchor for every topic.
describe("help topics", () => {
  test("the page re-exports the topic data used by the layout", () => {
    expect(HELP_TOPICS).toBe(SHARED_HELP_TOPICS);
  });

  test("draft help explains account sync, expiry and safe retry", () => {
    const draft = HELP_TOPICS.find((topic) => topic.id === "drafts")!;
    expect(draft.summary).toContain("account");
    expect(draft.steps.join(" ")).toContain("seven days");
    expect(draft.steps.join(" ")).toContain("Not saved");
    expect(
      HELP_TOPICS.find((topic) => topic.id === "recover-invoice")?.steps.join(
        " ",
      ),
    ).toContain("Retry original invoice");
  });
  test("ids are unique and content is complete", () => {
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of HELP_TOPICS) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.summary.length).toBeGreaterThan(0);
      expect(t.steps.length).toBeGreaterThan(0);
    }
  });

  test("the page renders one anchored card per topic", () => {
    render(<Help />);
    for (const t of HELP_TOPICS) {
      expect(document.getElementById(t.id)).toBeTruthy();
      expect(screen.getByTestId(`help-topic-${t.id}`)).toBeTruthy();
    }
    expect(screen.getByTestId("link-help-contact")).toBeTruthy();
  });

  test("the contextual deep-link targets exist", () => {
    for (const id of ["stamping", "consent", "vat", "month-end"]) {
      expect(HELP_TOPICS.some((t) => t.id === id)).toBe(true);
    }
  });
});
