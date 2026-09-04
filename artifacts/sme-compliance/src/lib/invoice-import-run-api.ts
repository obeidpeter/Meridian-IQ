import {
  createInvoiceImportRun,
  getInvoiceImportRun,
  commitInvoiceImportChunk,
  finalizeInvoiceImportRun,
  type ImportRunManifest,
  type ImportRunDetail,
  type InvoiceImportResult,
  type InvoiceImportRow,
} from "@workspace/api-client-react";
export type {
  ImportRunManifest,
  ImportRunDetail,
} from "@workspace/api-client-react";
export interface ImportRunApi {
  create(manifest: ImportRunManifest): Promise<ImportRunDetail>;
  get(id: string): Promise<ImportRunDetail>;
  commit(
    id: string,
    index: number,
    rows: InvoiceImportRow[],
    key: string,
  ): Promise<{
    runId: string;
    chunkIndex: number;
    nextChunkIndex: number;
    result: InvoiceImportResult;
  }>;
  finalize(id: string): Promise<ImportRunDetail>;
}
export function invoiceImportRunApi(signal?: AbortSignal): ImportRunApi {
  return {
    create: (manifest) => createInvoiceImportRun(manifest, { signal }),
    get: (id) => getInvoiceImportRun(id, { signal }),
    commit: (id, index, rows, key) =>
      commitInvoiceImportChunk(
        id,
        index,
        { rows },
        { headers: { "X-Idempotency-Key": key }, signal },
      ),
    finalize: (id) => finalizeInvoiceImportRun(id, {}, { signal }),
  };
}
