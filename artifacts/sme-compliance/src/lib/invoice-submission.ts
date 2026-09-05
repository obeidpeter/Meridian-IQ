import type { InvoiceInput } from "@workspace/api-client-react";
import type { DraftState } from "./invoice-draft";
import { errorStatus } from "./errors";

export type InvoiceSubmission =
  | { status: "pending"; key: string; body: InvoiceInput; draft: DraftState }
  | { status: "succeeded"; key: string; invoiceId: string }
  | { status: "blocked"; key: string };

export const submissionStorageKey = (scope: string, id: string) =>
  `${scope}:${id}:submission`;

export function readInvoiceSubmission(
  scope: string,
  id: string,
): InvoiceSubmission | undefined {
  const key = `invoice-create:${id}`;
  try {
    const raw = localStorage.getItem(submissionStorageKey(scope, id));
    if (!raw) return undefined;
    const value = JSON.parse(raw);
    if (value.key !== key) return { status: "blocked", key };
    if (value.status === "succeeded" && typeof value.invoiceId === "string")
      return value;
    if (
      value.status === "pending" &&
      value.body &&
      value.draft &&
      [
        "supplierPartyId",
        "buyerPartyId",
        "invoiceNumber",
        "currency",
        "issueDate",
      ].every((field) => typeof value.body[field] === "string") &&
      Array.isArray(value.body.lines) &&
      value.body.lines.length &&
      value.body.lines.every(
        (line: Record<string, unknown>) =>
          line &&
          ["description", "quantity", "unitPrice", "vatRate"].every(
            (field) => typeof line[field] === "string",
          ),
      ) &&
      [
        "invoiceNumber",
        "buyerPartyId",
        "issueDate",
        "dueDate",
        "currency",
        "fxRateToNgn",
        "whtCategory",
      ].every((field) => typeof value.draft[field] === "string") &&
      Array.isArray(value.draft.lines) &&
      value.draft.lines.length &&
      value.draft.lines.every(
        (line: Record<string, unknown>) =>
          line &&
          ["description", "quantity", "unitPrice", "vatRate"].every(
            (field) => typeof line[field] === "string",
          ),
      )
    )
      return value;
    return { status: "blocked", key };
  } catch {
    // Never interpret corrupt or inaccessible recovery as permission for a new command.
    return { status: "blocked", key };
  }
}

export function writeInvoiceSubmission(
  scope: string,
  id: string,
  value: InvoiceSubmission,
) {
  const key = submissionStorageKey(scope, id);
  const json = JSON.stringify(value);
  localStorage.setItem(key, json);
  if (localStorage.getItem(key) !== json)
    throw new Error(
      "Could not preserve the original invoice request. Nothing was sent.",
    );
}

export function isDefinitiveFirstRejection(error: unknown) {
  const status = errorStatus(error);
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  // The create route rolls back rejected input. A later rejection cannot settle an earlier lost response.
  return (status === 400 || status === 422) && typeof data?.error === "string";
}
