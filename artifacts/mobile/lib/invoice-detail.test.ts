import { test } from "node:test";
import assert from "node:assert/strict";
import type { SubmissionAttempt } from "@workspace/api-client-react";
import {
  ATTEMPT_ICON,
  attemptFailed,
  attemptIconColor,
  latestFailedErrorCode,
  LIGHT_META,
  sortAttemptsNewestFirst,
  statusLightPresentation,
} from "./invoice-detail.ts";

const attempt = (
  id: string,
  attemptNo: number,
  status: SubmissionAttempt["status"],
  errorCode?: string | null,
): SubmissionAttempt => ({
  id,
  invoiceId: "inv-1",
  rail: "rail_primary",
  attemptNo,
  idempotencyKey: `key-${id}`,
  correlationId: null,
  status,
  errorCode,
  createdAt: "2026-09-01T09:00:00Z",
});

test("sortAttemptsNewestFirst: highest attemptNo first, ties keep reverse API order", () => {
  // The API lists oldest-first; rows of one try share attemptNo with the
  // terminal answer LAST, so the terminal row must lead its pending sibling.
  const api = [
    attempt("a1-pending", 1, "pending"),
    attempt("a1-rejected", 1, "rejected", "MBS_INVALID_TIN"),
    attempt("a2-pending", 2, "pending"),
    attempt("a2-accepted", 2, "accepted"),
  ];
  assert.deepEqual(
    sortAttemptsNewestFirst(api).map((a) => a.id),
    ["a2-accepted", "a2-pending", "a1-rejected", "a1-pending"],
  );
  // Pure: the input order is untouched.
  assert.deepEqual(
    api.map((a) => a.id),
    ["a1-pending", "a1-rejected", "a2-pending", "a2-accepted"],
  );
  assert.deepEqual(sortAttemptsNewestFirst([]), []);
});

test("latestFailedErrorCode: the newest rejected/error attempt with a code wins; accepted rows are ignored", () => {
  const sorted = sortAttemptsNewestFirst([
    attempt("a1", 1, "rejected", "MBS_INVALID_TIN"),
    attempt("a2", 2, "error", "MBS_SCHEMA_INVALID"),
    attempt("a3", 3, "accepted", "IGNORED"),
  ]);
  assert.equal(latestFailedErrorCode(sorted), "MBS_SCHEMA_INVALID");
  // A failure without a code falls through to the older coded one.
  assert.equal(
    latestFailedErrorCode(
      sortAttemptsNewestFirst([
        attempt("a1", 1, "rejected", "MBS_DUPLICATE"),
        attempt("a2", 2, "error", null),
      ]),
    ),
    "MBS_DUPLICATE",
  );
  assert.equal(
    latestFailedErrorCode([attempt("a1", 1, "accepted", "IGNORED")]),
    undefined,
  );
  assert.equal(latestFailedErrorCode([attempt("a1", 1, "error")]), undefined);
  assert.equal(latestFailedErrorCode([]), undefined);
});

test("attemptFailed and the icon vocabulary: terminal failures are critical, waits are muted", () => {
  assert.equal(attemptFailed(attempt("a", 1, "rejected")), true);
  assert.equal(attemptFailed(attempt("a", 1, "error")), true);
  assert.equal(attemptFailed(attempt("a", 1, "pending")), false);
  assert.equal(attemptFailed(attempt("a", 1, "accepted")), false);
  assert.equal(ATTEMPT_ICON.accepted.toneKey, "success");
  assert.equal(ATTEMPT_ICON.pending.toneKey, "muted");
  assert.equal(ATTEMPT_ICON.rejected.toneKey, "critical");
  assert.equal(ATTEMPT_ICON.rejected.icon, "x-circle");
});

test("attemptIconColor maps each tone key to its palette token", () => {
  const colors = {
    primary: "#primary",
    destructiveText: "#destructiveText",
    mutedForeground: "#muted",
  };
  assert.equal(attemptIconColor({ toneKey: "success" }, colors), "#primary");
  assert.equal(
    attemptIconColor({ toneKey: "critical" }, colors),
    "#destructiveText",
  );
  assert.equal(attemptIconColor({ toneKey: "muted" }, colors), "#muted");
});

const palette = {
  success: "#success",
  warning: "#warning",
  destructive: "#destructive",
  destructiveText: "#destructiveText",
  foreground: "#foreground",
};

test("statusLightPresentation: green and amber carry their colour on dot and icon, label on foreground", () => {
  const green = statusLightPresentation(
    { light: "green", reasons: [], recommendedAction: "Nothing to do." },
    palette,
  );
  assert.deepEqual(green, {
    lightMeta: LIGHT_META.green,
    lightDotColor: "#success",
    lightIconColor: "#success",
    lightLabelColor: "#foreground",
    lightA11yLabel:
      "Compliance status: Green. Recommended action: Nothing to do.",
  });
  const amber = statusLightPresentation(
    {
      light: "amber",
      reasons: ["Due in 3 days", "Buyer TIN unverified"],
      recommendedAction: "Submit before Friday.",
    },
    palette,
  );
  assert.equal(amber.lightMeta, LIGHT_META.amber);
  assert.equal(amber.lightDotColor, "#warning");
  assert.equal(amber.lightIconColor, "#warning");
  assert.equal(amber.lightLabelColor, "#foreground");
  // Icon + word + reasons + action in one label: colour is never the only
  // signal, and a screen reader hears the whole card at once.
  assert.equal(
    amber.lightA11yLabel,
    "Compliance status: Amber. Due in 3 days. Buyer TIN unverified. Recommended action: Submit before Friday.",
  );
});

test("statusLightPresentation: red uses the text-tuned red for icon and label; no light means no presentation", () => {
  const red = statusLightPresentation(
    {
      light: "red",
      reasons: ["Rejected by the rail"],
      recommendedAction: "Fix the TIN.",
    },
    palette,
  );
  assert.equal(red.lightMeta, LIGHT_META.red);
  assert.equal(red.lightDotColor, "#destructive");
  assert.equal(red.lightIconColor, "#destructiveText");
  assert.equal(red.lightLabelColor, "#destructiveText");
  assert.equal(
    red.lightA11yLabel,
    "Compliance status: Red. Rejected by the rail. Recommended action: Fix the TIN.",
  );
  assert.deepEqual(statusLightPresentation(undefined, palette), {
    lightMeta: null,
    lightDotColor: "#destructive",
    lightIconColor: "#destructive",
    lightLabelColor: "#foreground",
    lightA11yLabel: undefined,
  });
});
