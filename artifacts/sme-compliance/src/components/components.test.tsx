// @vitest-environment jsdom
// Component-level coverage for the small shared SME components — the layer
// between the pure-helper unit tests and the full e2e journeys.
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClerkDisabledBanner } from "./clerk-disabled-banner";
import { ClerkUsageBreakdown } from "./clerk-usage-breakdown";
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

describe("ClerkUsageBreakdown", () => {
  test("lists humanized purposes by spend descending, hiding zero rows", () => {
    render(
      <ClerkUsageBreakdown
        byPurpose={[
          { purpose: "ask_clerk", tokens: 200 },
          { purpose: "extract_invoice", tokens: 12_400 },
          { purpose: "segment_batch", tokens: 0 },
        ]}
      />,
    );
    const list = screen.getByTestId("breakdown-clerk-usage");
    const rows = Array.from(list.children).map((c) => c.textContent);
    expect(rows).toEqual(["Extract invoice12.4K", "Ask clerk200"]);
    // The exact figure stays reachable via the compact value's title.
    expect(
      screen
        .getByTestId("row-usage-purpose-extract_invoice")
        .querySelector("[title]")!
        .getAttribute("title"),
    ).toBe("12,400 tokens");
    expect(screen.queryByTestId("text-usage-purpose-more")).toBeNull();
  });

  test("folds rows past the cap into a +N more line", () => {
    render(
      <ClerkUsageBreakdown
        byPurpose={Array.from({ length: 6 }, (_, i) => ({
          purpose: `purpose_${i}`,
          tokens: 600 - i * 100,
        }))}
      />,
    );
    expect(
      screen.getByTestId("breakdown-clerk-usage").children,
    ).toHaveLength(5); // 4 rows + the fold line
    expect(screen.getByTestId("text-usage-purpose-more").textContent).toBe(
      "+2 more",
    );
  });

  test("renders nothing when there has been no spend", () => {
    const { container: empty } = render(<ClerkUsageBreakdown byPurpose={[]} />);
    expect(empty.firstElementChild).toBeNull();
    // Version skew: a pre-0.35.0 server doesn't send byPurpose at all.
    const { container: absent } = render(<ClerkUsageBreakdown />);
    expect(absent.firstElementChild).toBeNull();
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
