import type {
  InvoiceImportResult,
  InvoiceImportRow,
} from "@workspace/api-client-react";
import { canonicalPayloadHash, stableCommandKey } from "./idempotent-command";
import type { ImportRunApi, ImportRunManifest } from "./invoice-import-run-api";

const IMPORT_CHUNK_SIZE = 100;
export interface InvoiceImportRun {
  version: 1;
  id: string;
  scope: string;
  clientPartyId: string;
  rows: InvoiceImportRow[];
  hash: string;
  expiresAt: string;
  started: boolean;
  manifest: ImportRunManifest;
}
const importRunStorageKey = (scope: string) => `meridianiq:import-run:${scope}`;
export function saveImportRun(run: InvoiceImportRun): boolean {
  try {
    localStorage.setItem(importRunStorageKey(run.scope), JSON.stringify(run));
    return true;
  } catch {
    return false;
  }
}
export function readImportRun(scope: string): InvoiceImportRun | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(importRunStorageKey(scope)) ?? "null",
    ) as InvoiceImportRun | null;
    if (
      !value ||
      value.version !== 1 ||
      value.scope !== scope ||
      !/^[0-9a-f-]{36}$/i.test(value.id) ||
      typeof value.clientPartyId !== "string" ||
      typeof value.hash !== "string" ||
      typeof value.started !== "boolean" ||
      !value.manifest ||
      value.manifest.id !== value.id ||
      !Array.isArray(value.manifest.chunkHashes) ||
      !Array.isArray(value.rows) ||
      !value.rows.length ||
      value.rows.length > 5000 ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now()
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function clearImportRun(scope: string) {
  try {
    localStorage.removeItem(importRunStorageKey(scope));
  } catch {
    /* A failed clear must not change the active in-memory run. */
  }
}
export async function newImportRun(
  scope: string,
  clientPartyId: string,
  rows: InvoiceImportRow[],
  work: { id?: string; check(): void } = { check() {} },
): Promise<InvoiceImportRun> {
  work.check();
  const id = work.id ?? crypto.randomUUID();
  rows = structuredClone(rows);
  const chunkHashes: string[] = [];
  for (let offset = 0; offset < rows.length; offset += IMPORT_CHUNK_SIZE) {
    work.check();
    chunkHashes.push(
      await canonicalPayloadHash(
        rows.slice(offset, offset + IMPORT_CHUNK_SIZE),
      ),
    );
    work.check();
  }
  const hash = await stableCommandKey(scope, { clientPartyId, rows });
  work.check();
  return {
    version: 1,
    id,
    scope,
    clientPartyId,
    rows: structuredClone(rows),
    hash,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    started: false,
    manifest: {
      id,
      clientPartyId,
      totalRows: rows.length,
      chunkSize: IMPORT_CHUNK_SIZE,
      chunkHashes,
    },
  };
}
function importChunkKey(runId: string, index: number) {
  return `${runId}:${index}`;
}

export async function executeImportRun(
  run: InvoiceImportRun,
  api: ImportRunApi,
  progress?: (completed: number, total: number) => void,
  work: { check(): void } = { check() {} },
): Promise<InvoiceImportResult> {
  work.check();
  run = structuredClone(run);
  const hash = await stableCommandKey(run.scope, {
    clientPartyId: run.clientPartyId,
    rows: run.rows,
  });
  work.check();
  if (run.hash !== hash)
    throw new Error(
      "The saved import changed. Start a new import instead of reusing its keys.",
    );
  const manifest = run.manifest;
  if (
    manifest.id !== run.id ||
    manifest.clientPartyId !== run.clientPartyId ||
    manifest.totalRows !== run.rows.length ||
    manifest.chunkSize !== IMPORT_CHUNK_SIZE ||
    manifest.chunkHashes.length !==
      Math.ceil(run.rows.length / IMPORT_CHUNK_SIZE)
  )
    throw new Error("The saved import manifest is invalid.");
  for (let index = 0; index < manifest.chunkHashes.length; index++) {
    work.check();
    const hash = await canonicalPayloadHash(
      run.rows.slice(
        index * manifest.chunkSize,
        (index + 1) * manifest.chunkSize,
      ),
    );
    work.check();
    if (manifest.chunkHashes[index] !== hash)
      throw new Error("The saved import no longer matches its manifest.");
  }
  work.check();
  await api.create(manifest);
  work.check();
  let remote = await api.get(run.id);
  work.check();
  const chunks = manifest.chunkHashes.length;
  const check = () => {
    if (
      remote.id !== run.id ||
      remote.manifestHash !== expectedManifestHash ||
      remote.clientPartyId !== manifest.clientPartyId ||
      remote.totalRows !== manifest.totalRows ||
      remote.chunkSize !== manifest.chunkSize ||
      JSON.stringify(remote.chunkHashes) !==
        JSON.stringify(manifest.chunkHashes) ||
      !Number.isInteger(remote.nextChunkIndex) ||
      remote.nextChunkIndex < 0 ||
      remote.nextChunkIndex > chunks
    )
      throw new Error("Server checkpoint does not match this import manifest.");
  };
  const expectedManifestHash = await canonicalPayloadHash(manifest);
  work.check();
  check();
  progress?.(remote.nextChunkIndex, chunks);
  while (remote.nextChunkIndex < chunks) {
    work.check();
    const index = remote.nextChunkIndex;
    const rows = run.rows.slice(
      index * manifest.chunkSize,
      (index + 1) * manifest.chunkSize,
    );
    await api.commit(run.id, index, rows, importChunkKey(run.id, index));
    work.check();
    remote = await api.get(run.id);
    work.check();
    check();
    if (remote.nextChunkIndex <= index)
      throw new Error(
        "Server checkpoint did not advance. Resume this import to reconcile.",
      );
    progress?.(remote.nextChunkIndex, chunks);
  }
  work.check();
  const finalized = await api.finalize(run.id);
  work.check();
  if (
    !finalized.result?.committed ||
    finalized.status !== "completed" ||
    finalized.result.total !== run.rows.length
  )
    throw new Error("Import finalization was not confirmed. Resume this run.");
  return finalized.result;
}
