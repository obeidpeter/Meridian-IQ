import type { InvoiceInput } from "@workspace/api-client-react";
import type { LineDraft } from "./invoice-form";

export const INVOICE_INTENT_PREFIX = "miq_invoice_intent:";
export interface InvoiceIntentScope {
  userId: string;
  firmId: string | null;
  clientPartyId: string;
}
export interface InvoiceIntentForm {
  buyerPartyId: string | null;
  invoiceNumber: string;
  issueDate: string;
  notes: string;
  lines: LineDraft[];
}
export interface InvoiceIntent {
  version: 1;
  scope: InvoiceIntentScope;
  key: string | null;
  form: InvoiceIntentForm;
  payload: InvoiceInput | null;
  invoiceId: string | null;
}
interface IntentStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: string[]): Promise<unknown>;
}
let queue: Promise<unknown> = Promise.resolve();
function ordered<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => {});
  return result;
}
export function invoiceIntentStorageKey(scope: InvoiceIntentScope): string {
  return (
    INVOICE_INTENT_PREFIX +
    JSON.stringify([scope.userId, scope.firmId, scope.clientPartyId])
  );
}
export function newInvoiceIntent(
  scope: InvoiceIntentScope,
  form: InvoiceIntentForm,
): InvoiceIntent {
  // An intent identifier, not a credential. Multiple random components plus
  // time keep independent identical invoices distinct without a native module.
  const key = [
    "mobile",
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join("-");
  return { version: 1, scope, key, form, payload: null, invoiceId: null };
}

export function prepareInvoiceIntent(
  intent: InvoiceIntent,
  form: InvoiceIntentForm,
  payload: InvoiceInput,
): InvoiceIntent {
  if (
    intent.payload &&
    JSON.stringify(intent.payload) !== JSON.stringify(payload)
  ) {
    throw new Error(
      "This attempt is bound to the original invoice. Restore the original draft to retry, or open the saved draft to edit it. Reset the form only to start a separate invoice.",
    );
  }
  return { ...intent, form, payload };
}
export function confirmInvoiceIntent(
  intent: InvoiceIntent,
  invoiceId: string,
): InvoiceIntent {
  return { ...intent, key: null, invoiceId };
}
export function readInvoiceIntent(
  storage: IntentStorage,
  scope: InvoiceIntentScope,
): Promise<InvoiceIntent | null> {
  return ordered(async () => {
    const raw = await storage.getItem(invoiceIntentStorageKey(scope));
    if (!raw) return null;
    const value = JSON.parse(raw) as InvoiceIntent;
    const validScope =
      value.scope &&
      invoiceIntentStorageKey(value.scope) === invoiceIntentStorageKey(scope);
    const form = value.form;
    if (
      value.version !== 1 ||
      !validScope ||
      !form ||
      ![form.invoiceNumber, form.issueDate, form.notes].every(
        (field) => typeof field === "string",
      ) ||
      !(form.buyerPartyId === null || typeof form.buyerPartyId === "string") ||
      !Array.isArray(form.lines) ||
      !form.lines.every(
        (line) =>
          line &&
          ["key", "description", "quantity", "unitPrice", "vatRate"].every(
            (key) => typeof line[key as keyof LineDraft] === "string",
          ),
      ) ||
      !(value.invoiceId === null || typeof value.invoiceId === "string") ||
      !(
        (typeof value.key === "string" &&
          /^[A-Za-z0-9._:-]{1,128}$/.test(value.key)) ||
        (value.key === null && typeof value.invoiceId === "string")
      ) ||
      !(
        value.payload === null ||
        (value.payload &&
          typeof value.payload === "object" &&
          value.payload.supplierPartyId === scope.clientPartyId &&
          Array.isArray(value.payload.lines))
      )
    ) {
      throw new Error("Saved invoice draft could not be read safely.");
    }
    return value;
  });
}
export function saveInvoiceIntent(
  storage: IntentStorage,
  intent: InvoiceIntent,
  isCurrent: () => boolean,
): Promise<void> {
  const serialized = JSON.stringify(intent);
  return ordered(async () => {
    if (!isCurrent())
      throw new Error("This invoice belongs to a previous session.");
    await storage.setItem(invoiceIntentStorageKey(intent.scope), serialized);
  });
}
export function removeInvoiceIntent(
  storage: IntentStorage,
  scope: InvoiceIntentScope,
  isCurrent: () => boolean,
): Promise<void> {
  return ordered(async () => {
    if (isCurrent()) await storage.removeItem(invoiceIntentStorageKey(scope));
  });
}
export function clearInvoiceIntents(storage: IntentStorage): Promise<void> {
  return ordered(async () => {
    const keys = (await storage.getAllKeys()).filter((key) =>
      key.startsWith(INVOICE_INTENT_PREFIX),
    );
    if (keys.length) await storage.multiRemove(keys);
  });
}
