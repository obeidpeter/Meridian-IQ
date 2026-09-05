import {
  deleteInvoiceDraft,
  getInvoiceDraft,
  listInvoiceDrafts,
  saveInvoiceDraft,
  type ServerInvoiceDraft,
} from "@workspace/api-client-react";
import type { DraftState } from "./invoice-draft";

export type { ServerInvoiceDraft } from "@workspace/api-client-react";
export interface InvoiceDraftApi {
  get(id: string, signal?: AbortSignal): Promise<ServerInvoiceDraft>;
  save(
    id: string,
    input: { expectedRevision: number; writeId: string; draft: DraftState },
    signal?: AbortSignal,
  ): Promise<ServerInvoiceDraft>;
  remove(
    id: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<void>;
}
export function invoiceDraftApi(clientPartyId: string): InvoiceDraftApi {
  return {
    get: (id, signal) => getInvoiceDraft(id, { clientPartyId }, { signal }),
    save: (id, input, signal) =>
      saveInvoiceDraft(id, { clientPartyId, ...input }, { signal }),
    remove: (id, expectedRevision, signal) =>
      deleteInvoiceDraft(id, { clientPartyId, expectedRevision }, { signal }),
  };
}
export function listServerInvoiceDrafts(
  clientPartyId: string,
  offset: number,
  signal?: AbortSignal,
) {
  return listInvoiceDrafts({ clientPartyId, offset }, { signal });
}
