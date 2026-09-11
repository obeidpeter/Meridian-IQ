import { test, expect, describe } from "vitest";
import {
  RESPONSE_DESCRIPTIONS,
  SUBMIT_LABELS,
  errorDescription,
  noteRequiredFor,
  noteValidationError,
  responseRecordedCopy,
  type ResponseState,
  RESPONSE_FINALITY,
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
    expect(err).toContain("clarify");
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
    expect(RESPONSE_DESCRIPTIONS.confirmed).toContain("financing assessment");
    expect(RESPONSE_DESCRIPTIONS.confirmed).toContain(
      "does not approve financing or make a payment",
    );
    expect(RESPONSE_DESCRIPTIONS.queried).toContain(
      "cannot change this response",
    );
    expect(RESPONSE_DESCRIPTIONS.queried).toContain("new confirmation request");
    expect(RESPONSE_DESCRIPTIONS.rejected).toContain(
      "new confirmation request",
    );
    for (const text of Object.values(RESPONSE_DESCRIPTIONS)) {
      expect(text).not.toMatch(
        /notified|notifies|sends it to the supplier|must reissue/,
      );
    }
  });

  test("submit labels stay action-specific", () => {
    expect(SUBMIT_LABELS.confirmed).toBe("Confirm invoice");
    expect(SUBMIT_LABELS.queried).toBe("Send question");
    expect(SUBMIT_LABELS.rejected).toBe("Reject invoice");
  });
});

describe("responseRecordedCopy", () => {
  test("each recorded response states what happened and what happens next", () => {
    expect(responseRecordedCopy("confirmed").title).toBe("Invoice confirmed");
    expect(responseRecordedCopy("queried").title).toBe("Question sent");
    expect(responseRecordedCopy("rejected").title).toBe("Invoice rejected");
    expect(responseRecordedCopy("queried").description).toContain(
      "new confirmation request",
    );
    expect(responseRecordedCopy("queried").description).toContain(
      "cannot be changed",
    );
    for (const s of ["confirmed", "rejected"] as const) {
      expect(responseRecordedCopy(s).description).toContain(
        "can view your recorded response",
      );
      expect(responseRecordedCopy(s).description).not.toMatch(
        /notified|must reissue/,
      );
    }
  });
});

describe("errorDescription", () => {
  test("maps the well-known statuses to human copy", () => {
    expect(errorDescription({ status: 401 })).toContain("session has expired");
    expect(errorDescription({ status: 403 })).toContain("permission");
    expect(errorDescription({ status: 409 })).toContain(
      "invoice's current status",
    );
    expect(errorDescription({ status: 500 })).toContain(
      "Check the latest invoice status before trying again",
    );
    expect(errorDescription({ status: 503 })).toContain("could not confirm");
    expect(
      errorDescription({
        status: 409,
        data: { error: "This invoice is already settled." },
      }),
    ).toBe("This invoice is already settled.");
  });

  test("falls back to the Error message, then to a generic line", () => {
    expect(errorDescription(new Error("boom"))).toBe("boom");
    expect(errorDescription({})).toBe(
      "Valo could not confirm the result. Check the latest invoice status before trying again.",
    );
    expect(errorDescription(undefined)).toBe(
      "Valo could not confirm the result. Check the latest invoice status before trying again.",
    );
  });
});

describe("RESPONSE_FINALITY", () => {
  test("says the response is one-shot before the buyer submits", () => {
    expect(RESPONSE_FINALITY).toContain("permanently");
    expect(RESPONSE_FINALITY).toContain("cannot be changed");
  });
});
