// The preparation queue is a shortlist of at most eight clients; the pin is
// that a longer book is SAID to be longer, so the list never looks complete
// when it is not.
import { describe, expect, test } from "vitest";
import { queueOverflowNote } from "./filing-desk";

describe("queueOverflowNote", () => {
  test("nothing to say when every pending client fits", () => {
    expect(queueOverflowNote(8, 8)).toBeNull();
    expect(queueOverflowNote(3, 3)).toBeNull();
    expect(queueOverflowNote(8, 0)).toBeNull();
  });

  test("names the shown and total counts and points at the full grid", () => {
    expect(queueOverflowNote(8, 30)).toBe(
      "Showing 8 of 30 clients — the full grid is in the cockpit below.",
    );
  });
});
