// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  filterHelpTopics,
  HelpFeedback,
  HelpSearchInput,
  useHelpSearch,
  type SearchableHelpTopic,
} from "./help-centre";

const TOPICS: SearchableHelpTopic[] = [
  {
    id: "stamp",
    title: "Stamp an invoice",
    summary: "Send a checked invoice to the tax rail.",
    steps: ["Review VAT", "Confirm submission"],
  },
  {
    id: "import",
    title: "Import records",
    summary: "Validate a spreadsheet before saving drafts.",
    steps: ["Upload CSV", "Review failed rows"],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("help centre", () => {
  test("searches titles, summaries, and steps case-insensitively", () => {
    expect(filterHelpTopics(TOPICS, "vat").map((topic) => topic.id)).toEqual([
      "stamp",
    ]);
    expect(
      filterHelpTopics(TOPICS, "SPREADSHEET").map((topic) => topic.id),
    ).toEqual(["import"]);
  });

  test("sends only closed aggregate events, never the search text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      const help = useHelpSearch(TOPICS, "sme_help");
      return (
        <HelpSearchInput
          query={help.query}
          onQueryChange={help.setQuery}
          resultCount={help.filteredTopics.length}
        />
      );
    }

    render(<Harness />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "private customer phrase" },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const payloads = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)),
    );
    expect(payloads).toEqual([
      { event: "help_opened", surface: "sme_help" },
      { event: "help_search_no_result", surface: "sme_help" },
    ]);
    expect(JSON.stringify(payloads)).not.toContain("private customer phrase");
  });

  test("records one anonymous feedback choice", () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<HelpFeedback surface="console_help" />);
    fireEvent.click(screen.getByRole("button", { name: /yes, this help/i }));
    fireEvent.click(screen.getByRole("button", { name: /no, this help/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)),
    ).toEqual({
      event: "help_helpful",
      surface: "console_help",
    });
  });
});
