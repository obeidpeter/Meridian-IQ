// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Help, HELP_TOPICS } from "./help";

afterEach(cleanup);

describe("console help topics", () => {
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

  test("invite-link help matches the product's no-email truth", () => {
    const invite = HELP_TOPICS.find((t) => t.id === "invite-links");
    expect(invite?.summary).toContain("never emails");
  });
});
