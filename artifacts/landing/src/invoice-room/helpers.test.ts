import { describe, expect, test } from "vitest";
import type { InvoiceRoomDetail } from "@workspace/api-client-react";
import { errorMessage, EVENT_LABEL, statusTone } from "./helpers";

function detail(settled: boolean, state?: string): InvoiceRoomDetail {
  return {
    payment: { settled },
    room: { identityVerified: true },
    confirmation: state ? { state } : null,
  } as InvoiceRoomDetail;
}

describe("invoice room status wording", () => {
  test("a settled record is not presented as provider confirmation", () => {
    expect(statusTone(detail(true)).label).toBe("Payment recorded");
    expect(EVENT_LABEL.payment_reported).toBe("Payment reported");
    expect(EVENT_LABEL.payment_confirmed).toBe("Payment confirmed");
  });

  test("keeps response states separate from payment", () => {
    expect(statusTone(detail(false, "confirmed")).label).toBe(
      "Invoice confirmed",
    );
    expect(statusTone(detail(false, "queried")).label).toBe("Question sent");
    expect(statusTone(detail(false, "rejected")).label).toBe("Rejected");
    expect(statusTone(detail(false)).label).toBe("Waiting for your response");
  });

  test("does not claim delivery or completion from a send or failed response", () => {
    expect(EVENT_LABEL.delivery_sent).toBe("Invoice link sent");
    expect(errorMessage(new Error("Failed to fetch"))).toContain(
      "before Valo could confirm the result",
    );
    expect(errorMessage(null)).toContain("invoice history before trying again");
  });
});
