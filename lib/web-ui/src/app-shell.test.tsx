// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ReleaseBadge,
  WorkspaceChip,
  releaseBadgeLabel,
  releaseBadgeTitle,
} from "./app-shell";

describe("ReleaseBadge", () => {
  test("labels a recognised tag by its release number and names the stage", () => {
    render(<ReleaseBadge tag="R1" />);
    const badge = screen.getByTestId("text-release-badge");
    expect(badge.textContent).toBe("Release 1");
    expect(badge.getAttribute("title")).toContain("R1");
    expect(badge.getAttribute("title")).toContain("Compliance MVP");
  });

  test("renders nothing for a missing or unknown tag (older server)", () => {
    const { container: none } = render(<ReleaseBadge tag={undefined} />);
    expect(none.textContent).toBe("");
    const { container: odd } = render(<ReleaseBadge tag="R9" />);
    expect(odd.textContent).toBe("");
  });

  test("label and title helpers agree with the manifest tags", () => {
    expect(releaseBadgeLabel("R0")).toBe("Release 0");
    expect(releaseBadgeLabel("R4")).toBe("Release 4");
    expect(releaseBadgeTitle("R0")).toContain("Field Kit core");
  });
});

describe("WorkspaceChip", () => {
  test("shows the workspace name with a title for the truncated case", () => {
    render(<WorkspaceChip name="Adaeze Foods Ltd" />);
    const chip = screen.getByTestId("text-workspace-chip");
    expect(chip.textContent).toBe("Adaeze Foods Ltd");
    expect(chip.getAttribute("title")).toBe("Adaeze Foods Ltd");
  });
});
