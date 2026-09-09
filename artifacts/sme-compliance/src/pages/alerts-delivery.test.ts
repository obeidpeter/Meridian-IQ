// Failed-row copy on the alert settings page: the server keeps failed-send
// detail deliberately generic ("Send failed" — raw provider errors are a log
// concern), so the page translates the generic case into something a client
// can act on while keeping any specific detail (failover notes, push
// outcomes) verbatim.
import { describe, expect, test } from "vitest";
import type { AlertDeliveryResult } from "@workspace/api-client-react";
import { deliveryDetail } from "./alerts";

const FRIENDLY =
  "Could not deliver — check the number or address, save, and try again.";

function result(over: Partial<AlertDeliveryResult>): AlertDeliveryResult {
  return { channel: "sms", status: "sent", ...over };
}

describe("deliveryDetail", () => {
  test("generic 'Send failed' becomes actionable copy", () => {
    expect(
      deliveryDetail(result({ status: "failed", detail: "Send failed" })),
    ).toBe(FRIENDLY);
  });

  test("a failed row with no detail gets the same friendly copy", () => {
    expect(deliveryDetail(result({ status: "failed", detail: null }))).toBe(
      FRIENDLY,
    );
  });

  test("specific failure detail is kept verbatim", () => {
    expect(
      deliveryDetail(
        result({
          channel: "push",
          status: "failed",
          detail: "Expo push service returned 500",
        }),
      ),
    ).toBe("Expo push service returned 500");
  });

  test("failover success detail is kept verbatim", () => {
    expect(
      deliveryDetail(
        result({
          status: "sent",
          detail: "Delivered via sms after whatsapp failed",
        }),
      ),
    ).toBe("Delivered via sms after whatsapp failed");
  });

  test("a detail-less non-failed row humanizes its status", () => {
    expect(deliveryDetail(result({ status: "skipped", detail: null }))).toBe(
      "Skipped",
    );
  });
});
