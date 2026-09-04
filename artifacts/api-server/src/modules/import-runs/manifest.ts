import { z } from "zod";
import { ImportInvoicesBody, ImportInvoicesResponse } from "@workspace/api-zod";
import { DomainError } from "../errors";
import { operationPayloadHash } from "../operations/command";

export const ImportRunManifestBody = z
  .object({
    id: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    clientPartyId: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    totalRows: z.number().int().min(1).max(5000),
    chunkSize: z.number().int().min(1).max(250),
    chunkHashes: z
      .array(z.string().regex(/^[0-9a-f]{64}$/))
      .min(1)
      .max(5000),
  })
  .strict()
  .refine(
    (manifest) =>
      manifest.chunkHashes.length ===
      Math.ceil(manifest.totalRows / manifest.chunkSize),
    {
      message: "chunkHashes must contain exactly one hash for each chunk",
      path: ["chunkHashes"],
    },
  );

export const ImportRunChunkBody = z
  .object({
    // Strict rows prevent hash ambiguity from silently stripped extra fields.
    rows: z
      .array(ImportInvoicesBody.shape.rows.element.strict())
      .min(1)
      .max(250),
  })
  .strict();

export const ImportRunChunkResponse = z.object({
  runId: z.string().uuid(),
  chunkIndex: z.number().int().min(0),
  nextChunkIndex: z.number().int().min(1),
  result: ImportInvoicesResponse,
});

export type ImportRunManifest = z.infer<typeof ImportRunManifestBody>;
export type ImportChunkRows = z.infer<typeof ImportRunChunkBody>["rows"];
export type ImportChunkResult = z.infer<typeof ImportInvoicesResponse>;

export function manifestHash(manifest: ImportRunManifest): string {
  return operationPayloadHash(manifest);
}

export function assertManifestChunk(
  manifest: Pick<ImportRunManifest, "chunkSize" | "totalRows" | "chunkHashes">,
  chunkIndex: number,
  rows: ImportChunkRows,
): void {
  if (
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= manifest.chunkHashes.length
  ) {
    throw new DomainError(
      "INVALID_CHUNK",
      "Chunk index is outside the import manifest",
      400,
    );
  }
  const offset = chunkIndex * manifest.chunkSize;
  const count = Math.min(manifest.chunkSize, manifest.totalRows - offset);
  if (
    rows.length !== count ||
    rows.some((row, index) => row.rowNumber !== offset + index + 1)
  ) {
    throw new DomainError(
      "INVALID_CHUNK_ROWS",
      "Chunk rows must match the manifest size and consecutive one-based row numbers",
      400,
    );
  }
  if (operationPayloadHash(rows) !== manifest.chunkHashes[chunkIndex]) {
    throw new DomainError(
      "IMPORT_CHUNK_CONFLICT",
      "Chunk payload does not match its immutable manifest hash",
      409,
    );
  }
}

export function assertCommittedChunkResult(
  result: ImportChunkResult,
  rows: ImportChunkRows,
): void {
  const created = result.rows.filter((row) => row.status === "created").length;
  const invalid = result.rows.filter((row) => row.status === "invalid").length;
  const numbers = new Set(result.rows.map((row) => row.rowNumber));
  if (
    !result.committed ||
    result.total !== rows.length ||
    result.rows.length !== rows.length ||
    result.createdCount !== created ||
    result.validCount !== created ||
    result.invalidCount !== invalid ||
    created + invalid !== rows.length ||
    numbers.size !== rows.length ||
    rows.some((row) => !numbers.has(row.rowNumber)) ||
    result.rows.some((row) =>
      row.status === "created" ? !row.invoiceId : row.invoiceId != null,
    )
  ) {
    throw new Error(
      "Import engine returned an inconsistent committed chunk result",
    );
  }
}

export function aggregateChunkResults(
  chunks: ImportChunkResult[],
): ImportChunkResult {
  return {
    total: chunks.reduce((sum, chunk) => sum + chunk.total, 0),
    validCount: chunks.reduce((sum, chunk) => sum + chunk.validCount, 0),
    invalidCount: chunks.reduce((sum, chunk) => sum + chunk.invalidCount, 0),
    createdCount: chunks.reduce((sum, chunk) => sum + chunk.createdCount, 0),
    committed: true,
    rows: chunks
      .flatMap((chunk) => chunk.rows)
      .sort((a, b) => a.rowNumber - b.rowNumber),
  };
}
