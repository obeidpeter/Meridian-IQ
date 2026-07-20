import { test, expect, describe } from "vitest";
import {
  RESPONSE_DESCRIPTIONS,
  SUBMIT_LABELS,
  errorDescription,
  noteRequiredFor,
  noteValidationError,
  responseRecordedCopy,
  type ResponseState,
} from "./respond";

const STATES: ResponseState[] = ["confirmed", "queried", "rejected"];

// The response form's pure logic: which actions demand a note, what the
// validation message says, and the copy that explains each outcome before
// and after submission.

describe("noteRequiredFor", () => {
  test("queries and rejections travel back as the note — required", () => {
    expect(noteRequiredFor("queried")).toBe(true);
    expect(noteRequiredFor("rejected")).toBe(true);
  });

  test("confirming needs no note, and no response picked needs nothing", () => {
    expect(noteRequiredFor("confirmed")).toBe(false);
    expect(noteRequiredFor(null)).toBe(false);
  });
});

describe("noteValidationError", () => {
  test("a confirmation submits without a note", () => {
    expect(noteValidationError("confirmed", "")).toBeNull();
    expect(noteValidationError(null, "")).toBeNull();
  });

  test("a blank or whitespace-only note blocks a query, with copy that says why", () => {
    const err = noteValidationError("queried", "");
    expect(err).toContain("clarifying");
    expect(err).toContain("supplier");
    expect(noteValidationError("queried", "   ")).toBe(err);
  });

  test("a rejection gets its own message — the reason travels to the supplier", () => {
    const err = noteValidationError("rejected", "");
    expect(err).toContain("rejecting");
    expect(err).toContain("supplier");
  });

  test("any real text satisfies the requirement", () => {
    expect(noteValidationError("queried", "VAT rate looks wrong")).toBeNull();
    expect(noteValidationError("rejected", "duplicate of INV-004")).toBeNull();
  });
});

describe("RESPONSE_DESCRIPTIONS and SUBMIT_LABELS", () => {
  test("every response state carries a non-empty, distinct outcome description", () => {
    const texts = STATES.map((s) => RESPONSE_DESCRIPTIONS[s]);
    for (const t of texts) expect(t.length).toBeGreaterThan(20);
    expect(new Set(texts).size).toBe(STATES.length);
  });

  test("descriptions name their consequence — notified supplier, financeable confirm, reissue on reject", () => {
    expect(RESPONSE_DESCRIPTIONS.confirmed).toContain("financeable");
    expect(RESPONSE_DESCRIPTIONS.queried).toContain("nothing is finalised");
    expect(RESPONSE_DESCRIPTIONS.rejected).toContain("reissue");
  });

  test("submit labels stay action-specific", () => {
    expect(SUBMIT_LABELS.confirmed).toBe("Confirm invoice");
    expect(SUBMIT_LABELS.queried).toBe("Send query");
    expect(SUBMIT_LABELS.rejected).toBe("Reject invoice");
  });
});

describe("responseRecordedCopy", () => {
  test("each recorded response states what happened and what happens next", () => {
    expect(responseRecordedCopy("confirmed").title).toBe("Invoice confirmed");
    expect(responseRecordedCopy("queried").title).toBe("Query sent");
    expect(responseRecordedCopy("rejected").title).toBe("Invoice rejected");
    for (const s of STATES) {
      expect(responseRecordedCopy(s).description).toContain("notified");
    }
  });
});

describe("errorDescription", () => {
  test("maps the well-known statuses to human copy", () => {
    expect(errorDescription({ status: 401 })).toContain("session has expired");
    expect(errorDescription({ status: 403 })).toContain("permission");
    expect(errorDescription({ status: 409 })).toContain("already responded");
    expect(errorDescription({ status: 500 })).toContain("Try again");
    expect(errorDescription({ status: 503 })).toContain("Try again");
  });

  test("falls back to the Error message, then to a generic line", () => {
    expect(errorDescription(new Error("boom"))).toBe("boom");
    expect(errorDescription({})).toBe("Something went wrong — try again.");
    expect(errorDescription(undefined)).toBe(
      "Something went wrong — try again.",
    );
  });
});
