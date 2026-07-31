// @vitest-environment jsdom
// The document-kind toggle on Send to Clerk (Notice Desk): a tax-authority
// notice rides the exact same capture rails as an invoice, marked only by
// documentKind: "notice" in the create body. Absent means invoice on the
// server, so the default (Invoice) submission must stay byte-identical to
// what this page sent before notices existed — no documentKind key at all.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClerkCaseCreateInput } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  createCalls: [] as { data: unknown }[],
  batchCalls: [] as { data: unknown }[],
  reset() {
    this.createCalls = [];
    this.batchCalls = [];
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: { capabilities: ["clerk.capture"] } }),
    useListClerkCases: () => ({
      data: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useGetClerkUsage: () => ({ data: undefined, isError: true }),
    useGetClerkCase: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useGetClerkBatch: () => ({ data: undefined }),
    useCreateClerkCase: () => ({
      isPending: false,
      mutate: (vars: { data: ClerkCaseCreateInput }) => {
        harness.createCalls.push(vars);
      },
    }),
    useCreateClerkBatch: () => ({
      isPending: false,
      mutate: (vars: { data: unknown }) => {
        harness.batchCalls.push(vars);
      },
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { ClerkCapture } from "./clerk-capture";

const NOTICE_TEXT = "NOTICE OF ASSESSMENT Ref FIRS/2026/0042 respond by 15 Aug";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ClerkCapture />
    </QueryClientProvider>,
  );
}

function submitText(text: string) {
  fireEvent.change(screen.getByTestId("input-capture-text"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByTestId("button-send-to-clerk"));
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("document-kind toggle", () => {
  test("defaults to Invoice and sends a body with NO documentKind key", async () => {
    renderPage();
    expect(
      screen.getByTestId("toggle-kind-invoice").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("toggle-kind-notice").getAttribute("aria-checked"),
    ).toBe("false");

    submitText("INVOICE No: 42 total 1000");
    await waitFor(() => expect(harness.createCalls).toHaveLength(1));
    // Byte-identical to the pre-notices submission: deepEqual proves no
    // documentKind key rode along.
    expect(harness.createCalls[0].data).toEqual({
      sourceType: "text",
      name: "pasted-text.txt",
      text: "INVOICE No: 42 total 1000",
    });
  });

  test("notice mode marks the body with documentKind: 'notice'", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("toggle-kind-notice"));
    expect(
      screen.getByTestId("toggle-kind-notice").getAttribute("aria-checked"),
    ).toBe("true");

    submitText(NOTICE_TEXT);
    await waitFor(() => expect(harness.createCalls).toHaveLength(1));
    expect(harness.createCalls[0].data).toEqual({
      sourceType: "text",
      documentKind: "notice",
      name: "pasted-text.txt",
      text: NOTICE_TEXT,
    });
  });

  test("notice mode hides the voice option behind an explanation (server rejects voice notices)", () => {
    renderPage();
    expect(screen.getByTestId("input-voice-file")).toBeTruthy();
    expect(screen.queryByTestId("text-notice-no-voice")).toBeNull();

    fireEvent.click(screen.getByTestId("toggle-kind-notice"));
    expect(screen.queryByTestId("input-voice-file")).toBeNull();
    expect(screen.getByTestId("text-notice-no-voice").textContent).toContain(
      "voice notes aren't accepted for notices",
    );
    // The form labels follow the kind.
    expect(screen.getByText("Notice document (PDF or photo)")).toBeTruthy();
  });

  test("notice mode hides batch intake (the splitter segments invoices only)", () => {
    renderPage();
    expect(screen.getByTestId("batch-toggle")).toBeTruthy();

    fireEvent.click(screen.getByTestId("toggle-kind-notice"));
    expect(screen.queryByTestId("batch-toggle")).toBeNull();
  });

  test("switching back to Invoice restores the voice option and the unmarked body", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("toggle-kind-notice"));
    fireEvent.click(screen.getByTestId("toggle-kind-invoice"));

    expect(screen.getByTestId("input-voice-file")).toBeTruthy();
    expect(screen.queryByTestId("text-notice-no-voice")).toBeNull();

    submitText("INVOICE No: 42 total 1000");
    await waitFor(() => expect(harness.createCalls).toHaveLength(1));
    expect(harness.createCalls[0].data).not.toHaveProperty("documentKind");
  });
});
