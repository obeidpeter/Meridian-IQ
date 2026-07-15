// @vitest-environment jsdom
// Component-level coverage for the small shared SME components — the layer
// between the pure-helper unit tests and the full e2e journeys.
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClerkDisabledBanner } from "./clerk-disabled-banner";
import { FilePickerButton } from "./file-picker-button";
import { RowStatusIcon } from "./row-status-icon";
import { SkeletonList } from "./skeleton-list";
import { BuyerSelectOptions } from "./buyer-select-options";
import { Select, SelectContent, SelectTrigger, SelectValue } from "./ui/select";
import type { Party } from "@workspace/api-client-react";

// RTL's auto-cleanup needs framework globals, which stay off here.
afterEach(cleanup);

describe("ClerkDisabledBanner", () => {
  test("pins the testid, tone and title; the page supplies the consequence", () => {
    render(<ClerkDisabledBanner>Please try again later.</ClerkDisabledBanner>);
    const banner = screen.getByTestId("banner-clerk-disabled");
    expect(banner.textContent).toContain("Clerk is unavailable right now");
    expect(banner.textContent).toContain("Please try again later.");
  });
});

describe("SkeletonList", () => {
  test("renders the requested stack with the page's row height and spacing", () => {
    const { container } = render(
      <SkeletonList count={3} itemClassName="h-16" className="space-y-2" />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toBe("space-y-2");
    expect(wrapper.children).toHaveLength(3);
    for (const item of Array.from(wrapper.children)) {
      expect(item.className).toContain("h-16");
    }
  });

  test("defaults to the usual space-y-3 stack", () => {
    const { container } = render(
      <SkeletonList count={5} itemClassName="h-20" />,
    );
    expect(container.firstElementChild!.className).toBe("space-y-3");
    expect(container.firstElementChild!.children).toHaveLength(5);
  });
});

describe("RowStatusIcon", () => {
  test("marks invalid rows destructive and valid rows emerald", () => {
    const { container: bad } = render(<RowStatusIcon invalid />);
    expect(bad.querySelector("svg")!.getAttribute("class")).toContain(
      "text-destructive",
    );
    const { container: ok } = render(<RowStatusIcon invalid={false} />);
    expect(ok.querySelector("svg")!.getAttribute("class")).toContain(
      "text-emerald-600",
    );
  });
});

describe("FilePickerButton", () => {
  test("forwards the picked file and resets so the same file can be re-picked", () => {
    const onFile = vi.fn();
    const { container } = render(
      <FilePickerButton accept=".csv" label="Upload CSV" onFile={onFile} />,
    );
    expect(screen.getByRole("button").textContent).toContain("Upload CSV");
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    )!;
    expect(input.getAttribute("accept")).toBe(".csv");
    const file = new File(["a,b"], "rows.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });
});

describe("BuyerSelectOptions", () => {
  const buyers = [
    { id: "b1", legalName: "Zenith Retail", tin: "12345678-0001" },
    { id: "b2", legalName: "Sahara Stores", tin: null },
  ] as unknown as Party[];

  test("renders every buyer with the TIN suffix or the no-TIN nudge", () => {
    render(
      <Select open>
        <SelectTrigger>
          <SelectValue placeholder="Select a customer…" />
        </SelectTrigger>
        <SelectContent>
          <BuyerSelectOptions buyers={buyers} />
        </SelectContent>
      </Select>,
    );
    expect(screen.getByText(/Zenith Retail — 12345678-0001/)).toBeTruthy();
    expect(screen.getByText(/Sahara Stores \(no TIN\)/)).toBeTruthy();
  });
});
