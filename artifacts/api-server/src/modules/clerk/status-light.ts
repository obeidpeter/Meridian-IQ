import type {
  Invoice,
  SubmissionAttempt,
  Confirmation,
  StampRecord,
} from "@workspace/db";

// Deterministic invoice status lights (Task #40). PURE RULES — no model call
// is ever involved here. The light is computed from the invoice lifecycle
// state, submission attempts, the stamp record and buyer confirmations, and
// every light comes with plain-language reasons and one recommended action.

export type StatusLight = "green" | "amber" | "red";

export interface StatusLightResult {
  light: StatusLight;
  reasons: string[];
  recommendedAction: string;
}

export interface StatusLightInput {
  invoice: Pick<Invoice, "status" | "dueDate">;
  attempts: Pick<SubmissionAttempt, "status" | "errorCode" | "createdAt">[];
  confirmations: Pick<Confirmation, "state" | "note" | "createdAt">[];
  stamp: Pick<StampRecord, "irn"> | null;
  today?: Date;
}

function latest<T extends { createdAt: Date }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
}

export function computeStatusLight(input: StatusLightInput): StatusLightResult {
  const { invoice, stamp } = input;
  const lastAttempt = latest(
    input.attempts.map((a) => ({ ...a, createdAt: a.createdAt })),
  );
  const lastConfirmation = latest(
    input.confirmations.map((c) => ({ ...c, createdAt: c.createdAt })),
  );

  // RED: something is broken and needs fixing now.
  if (invoice.status === "failed") {
    const code = lastAttempt?.errorCode;
    return {
      light: "red",
      reasons: [
        code
          ? `Submission was rejected with code ${code}`
          : "Submission failed on all rails",
      ],
      recommendedAction:
        "Open the rejection, fix the flagged field and resubmit the invoice.",
    };
  }
  if (lastConfirmation?.state === "rejected") {
    return {
      light: "red",
      reasons: [
        lastConfirmation.note
          ? `Buyer rejected the invoice: ${lastConfirmation.note}`
          : "Buyer rejected the invoice",
      ],
      recommendedAction:
        "Contact the buyer, resolve the dispute, then issue a correction or credit note if needed.",
    };
  }

  // AMBER: in-flight or needs attention, nothing broken yet.
  if (invoice.status === "draft" || invoice.status === "validated") {
    return {
      light: "amber",
      reasons: ["Invoice has not been submitted yet"],
      recommendedAction: "Review the draft and submit it for stamping.",
    };
  }
  if (invoice.status === "submitted") {
    return {
      light: "amber",
      reasons: ["Submitted and awaiting the tax authority stamp"],
      recommendedAction: "No action needed; the stamp normally arrives shortly.",
    };
  }
  if (lastConfirmation?.state === "queried") {
    return {
      light: "amber",
      reasons: [
        lastConfirmation.note
          ? `Buyer queried the invoice: ${lastConfirmation.note}`
          : "Buyer queried the invoice",
      ],
      recommendedAction: "Answer the buyer's query so confirmation can proceed.",
    };
  }
  if (invoice.status === "cancelled") {
    return {
      light: "amber",
      reasons: ["Invoice was cancelled"],
      recommendedAction: "No action needed.",
    };
  }
  if (invoice.status === "credited") {
    return {
      light: "amber",
      reasons: ["Invoice was fully credited by a credit note"],
      recommendedAction: "No action needed.",
    };
  }

  // GREEN: stamped (and possibly confirmed/settled) with no open issue.
  const reasons: string[] = [];
  if (stamp) reasons.push(`Stamped by the tax authority (IRN ${stamp.irn})`);
  else reasons.push("Invoice is in good standing");
  if (invoice.status === "confirmed") reasons.push("Buyer confirmed receipt");
  if (invoice.status === "settled") reasons.push("Payment has been observed");
  const overdue =
    invoice.dueDate &&
    invoice.status !== "settled" &&
    new Date(invoice.dueDate) < (input.today ?? new Date());
  if (overdue) {
    return {
      light: "amber",
      reasons: [...reasons, "Payment is past the due date"],
      recommendedAction: "Chase payment or request a buyer payment flag.",
    };
  }
  return {
    light: "green",
    reasons,
    recommendedAction: "No action needed.",
  };
}
