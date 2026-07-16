// Which parts of an invoice a rail rejection implicates, so the fix flow can
// point the user at the right fields instead of leaving them to guess.
// Mirrors the mobile edit screen's map (app/invoices/edit/[id].tsx) — extend
// both together when the catalogue grows a new fixable code.
export type FocusArea = "parties" | "invoice" | "lines" | "invoiceNumber";

export const ERROR_FOCUS: Record<string, FocusArea[]> = {
  MBS_INVALID_TIN: ["parties"],
  MBS_SCHEMA_INVALID: ["invoice", "lines"],
  MBS_DUPLICATE: ["invoiceNumber"],
};
