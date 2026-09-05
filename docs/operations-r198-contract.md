# Durable Operations: R198 Integration Contract

## Parent-owned integration

1. Register `migration0051` from `lib/db/src/migrations/0051_operation_recovery.ts` and export `operationsTable`/`OperationRow` from the schema index. The service uses parameterized SQL and does not require the export to execute. Apply the migration before enabling the routes. It creates the table, indexes, checks, owner RLS and completion/immutability triggers. No result-retention deletion is enabled; deleting a key would make an old retry execute again. Rollback preserves records and owner RLS.
2. Mount the default router from `artifacts/api-server/src/routes/operations.ts` in the existing authenticated `/api` router. Keep it inside the ordinary tenant transaction middleware. No request-transaction exemption is appropriate.
3. Wrap the existing create and committed-import handlers with `executeHttpOperation` from `modules/operations/http.ts`, as below. Keep existing validation, authorization, body-size and max-5000 checks. Import row/chunk savepoints remain owned by the import engine; this helper never opens an independent transaction.
4. Add the OpenAPI paths and header parameters below, regenerate the API client/Zod, and update exports. No OpenAPI or generated files are changed in this work.
5. Export `OperationRecoveryClient`, `OperationSyncState`, and optionally `reconcileOperations` from `lib/web-ui/src/index.ts`. Existing `useOperationJournal` and status component exports continue to work.
6. Pass a stable, tenant-bound fetcher to `useOperationJournal(scopeKey, { fetcher })`; pass its `syncState`, `refresh` and `recover` to `ActivityCenter` as `syncState`, `onRefresh`, `onRecover`. Do not pass a newly allocated fetcher on every render. The journal key MUST include actor, firm, and client scope; key changes cancel pending reads and immediately hide the previous account. Keep the shared logout/session cleanup integration.

## Create integration

After parsing and supplier scope authorization in `POST /invoices`:

```ts
await executeHttpOperation(req, res, {
  command: "invoice.create",
  clientPartyId: parsed.supplierPartyId,
  payload: parsed,
  execute: async () => {
    const bundle = await createDraft(
      { firmId, ...parsed },
      req.principal.userId,
    );
    return {
      statusCode: 201,
      body: CreateInvoiceResponse.parse(bundle),
      summary: "1 invoice draft created.",
    };
  },
});
```

## Import integration

Keep preview (`commit === false`) unchanged and outside durable command history. For committed imports, use the already validated `parsed` body, and `importOperationOutcome` from `modules/operations/command.ts`:

```ts
await executeHttpOperation(req, res, {
  command: "invoice.import",
  clientPartyId,
  payload: { ...parsed, commit: true },
  execute: async () => {
    const result = await importInvoices(
      firmId,
      clientPartyId,
      rows,
      true,
      req.principal.userId,
    );
    return {
      statusCode: 200,
      body: ImportInvoicesResponse.parse(result),
      ...importOperationOutcome(result),
    };
  },
});
```

Run response-schema parsing inside the callback. Never send HTTP data from the callback or rerun response shaping on replay. The helper serializes JSON once and sends those exact stored bytes, with the original HTTP status, for first delivery and replay. Only `X-Operation-Id` and `Idempotency-Replayed` are added; business response bodies remain unchanged. The request middleware must continue buffering the response until COMMIT. A thrown exception, validation failure or outer transaction rollback leaves neither business writes nor a completed command record. Such errors are NOT persisted as completed operations. An all-invalid partial import is a durable HTTP-200 result with operation status `failed`; mixed outcomes are `partial`.

## Command semantics

- `X-Idempotency-Key` is required for creates and committed imports: 1-128 ASCII characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Missing, duplicate/list, whitespace and invalid keys produce 400 `INVALID_IDEMPOTENCY_KEY`. Preview imports need no key. The operation ID from `beginOperation` may be reused as this key; providing `command` makes it the default `idempotencyKey`.
- Identity is `(firm, actor, command, key)`; actor is the authenticated principal's user ID or `apikey:<id>`, never a body field. Client scope is included in the payload hash and rechecked, not an extra key namespace.
- SHA-256 covers canonical JSON of `{clientPartyId, payload}`. Object-key order is irrelevant; array order, types and values matter. Persist keys by user intent, not globally by payload: two intentional identical imports require distinct run IDs. Never mint a fresh key just because a response timed out. Payload-hash-only keys would incorrectly deduplicate intentional repeat work indefinitely.
- The unique index serializes concurrent reservations until the first transaction commits or rolls back. A separate statement reads the winner under READ COMMITTED. Other isolation levels are rejected, so a stale transaction snapshot cannot execute a duplicate. See [PostgreSQL transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html).
- The service requires the caller's active tenant transaction, `meridian_app`, matching firm GUC and bypass off. It binds actor/client GUCs before operation-table access. The callback receives that same transaction; downstream `getDb()` resolves to it. Do not open a raw-pool or separate tenant transaction in the callback.
- Same key and payload returns the exact saved JSON/status without executing again. Changed payload returns 409 `IDEMPOTENCY_CONFLICT` without disclosing stored payloads. An inaccessible historical key returns the same generic 404 as an unknown operation.
- History is own-actor only, even for firm admins. Every read rechecks the principal's current `invoice.read`, firm, client restriction, and a non-archived client engagement. The operation wrapper additionally requires `invoice.write`. Cross-tenant operator/auditor scopes and missing client bindings are rejected. No endpoint accepts actor/firm/client filters.
- Committed history contains terminal results only. Running reservations are uncommitted and a deferred constraint trigger refuses an unfinished commit. A 404 lookup means no authorized committed result is visible, not proof that the request failed; an original request may still be running. Retry the SAME key and payload to resolve uncertainty safely.
- No API changes operation status from client assertions. Response payload hashes, actor IDs and supplier IDs are not exposed as operation metadata. Detailed results contain only the original authorized command response.

## Explicit OpenAPI additions

### Header parameters and responses

`POST /invoices`: required header `X-Idempotency-Key` with the string pattern above. `POST /invoices/import`: conditionally required for `commit:true`, described in the header documentation (OpenAPI cannot express that cross-parameter condition directly). Document 400 invalid/missing key and 409 mismatch as the existing domain error response shape. Successful responses add:

- `X-Operation-Id`: UUID, stable across replay.
- `Idempotency-Replayed`: string enum `true|false`.
- `Cache-Control`: `private, no-store`.

Expose `X-Operation-Id` and `Idempotency-Replayed` in CORS for supported cross-origin callers if they inspect headers. Header inspection is optional because recovery supports key lookup.

### OperationSummary schema

Required fields: `id` (UUID), `command` (`invoice.create|invoice.import`), `idempotencyKey` (bounded string above), `status` (`succeeded|partial|failed`), `title` (string), `route` (`/invoices`, `/import`, or `/import?run=<UUID>`), `summary` (string), `startedAt` and `updatedAt` (date-time strings). No tenant/actor/payload-hash fields. `OperationDetail` extends it with required `result: { statusCode: integer 200..299, body: any JSON value }`. Body is the saved CreateInvoiceResponse or ImportInvoicesResponse according to command; document that association explicitly.

### Second-device run recovery handoff

Operation list, detail and key lookup now derive `/import?run=<UUID>` from an actual `import_run_chunks.operation_id` reference joined to `import_runs`. Both joins require matching firm, actor and client ownership, on top of the existing current engagement/scope predicates and RLS. No route is inferred from an idempotency key or saved response body. Legacy imports, including run-shaped keys/results with no chunk reference, remain `/import`. This lets a fresh device reach a committed run without any local journal state. Recovery reads now require the migration 0054 tables as well as 0051.

For agent A: accept and retain the server-provided run URL when mapping operation summaries into shared journal records. The allowed route pattern is `^/(invoices|import(\?run=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)$`, maximum 48 characters. Reject arbitrary paths, other query parameters and non-UUID run identifiers. For the parent: only `OperationSummary.route` was updated in the central OpenAPI schema; regenerate API clients afterward. The standalone fragment has the identical route contract so a future structural merge cannot regress it.

PostgreSQL regression tests cover fresh-device list recovery, detail/key lookup, finalized runs, spoofed legacy keys/result bodies, and actor/client/tenant isolation. They use real committed operations and chunk/run references; their execution still requires an initialized disposable `DATABASE_URL`.

### Paths

- `GET /operations`, operationId `listOperations`: query `limit` optional integer 1..100, default 24; `cursor` optional opaque string max256. 200 `{operations: OperationSummary[], nextCursor: string|null}`. Cursor sorts by `(created_at DESC, id DESC)` and retains PostgreSQL timestamp precision. 400 invalid pagination; 401 unauthenticated; 403 missing capability/tenant/client scope.
- `GET /operations/lookup`, operationId `lookupOperation`: required query `command` enum and `idempotencyKey`. 200 OperationDetail; 400 invalid query/key; 401/403 as above; generic 404 for unavailable or unauthorized result. Mount literal lookup before `/:id`.
- `GET /operations/{id}`, operationId `getOperation`: UUID path `id`. 200 OperationDetail; 400 invalid UUID; 401/403 as above; same generic 404.

All three GET routes send `Cache-Control: private, no-store`, including errors. Server history queries are bounded and omit full response bodies from list results. The UI limits recent history to 24, but looks up unmatched durable local keys individually to recover commands older than the first page.

## customFetch integration (parent-owned)

The existing central client already merges custom headers, sends same-origin cookies, adds the unsafe-method CSRF marker, composes abort signals, enforces a timeout, and exposes error status. No central client edit is required:

```ts
const op = beginOperation(journalKey, {
  title: "Invoice import",
  kind: "import",
  route: "/import",
  command: "invoice.import",
  idempotencyKey: persistedImportIntentKey,
});
await importInvoices({
  ...existingOptions,
  headers: { "X-Idempotency-Key": op!.idempotencyKey! },
});
// Use the generated mutation's actual argument order; this is the header intent.
const fetchOperations = (path, options) =>
  customFetch(path, {
    ...options,
    responseType: "json",
    headers: { "x-firm-id": authenticatedFirmId },
  });
```

Construct one persisted random intent key before dispatch and reuse it across retries/refresh. For creates, a durable draft ID can namespace the intent. Include `command` and the exact request `idempotencyKey` in `beginOperation` so the journal can correlate local rows with remote results. A journal ID generated independently of the request key cannot reconcile. Do not infer failure from `ApiTimeoutError`, abort, network loss or JSON parse failure. Do not add blind automatic POST retries or generic content-hash deduplication in `customFetch`.

Server results and server-verification claims are memory-only. LocalStorage cannot prove completion and cannot restore a forged server-verification flag. Offline/unavailable server reads preserve last available UI records with their last verification time; 401/403 hides durable cached history. Current-scope changes cancel reconciliation and result reads. Dismissal of server history is view-local, not a server deletion or loss of idempotency guarantees.

## Implemented resumable imports

The implemented service is `modules/import-runs/service.ts`; mount the default router from `routes/import-runs.ts` under the authenticated `/api` router, inside ordinary request transactions. Register `migration0054` from `lib/db/src/migrations/0054_import_runs.ts` AFTER 0051. Export `importRunsTable`, `importRunChunksTable`, `ImportRunRow`, and `ImportRunChunkRow` from `lib/db/src/schema/import-runs.ts`. Both tables are created by the migration, with grants, owner RLS, immutable manifests/chunks, composite ownership keys, and a deferred checkpoint-consistency guard. No schema push is needed.

Each HTTP chunk owns one existing request transaction, holding its run row lock through commit. It delegates to the real `importInvoices` engine (the optional injected importer is for tests). That engine's parent-owned `withTransaction` row/chunk savepoints remain active; this layer opens no separate transaction. Invoice writes, operation response, chunk reference and checkpoint advancement commit together. Crashes or outer rollback erase the attempted chunk/checkpoint, while earlier requests remain durable. Concurrent duplicates serialize on the run and replay one operation. Out-of-order future chunks fail before executing. Earlier committed chunks remain replayable even after finalization.

### Exact run API for frontend and OpenAPI

All paths below are relative to `/api`; all return `Cache-Control: private, no-store` and use existing authentication/CSRF. Only the same authenticated actor, current firm/client scope and non-archived engagement may read a run. Writes additionally require `invoice.write`.

- `POST /invoice-import-runs`, operationId `createInvoiceImportRun`. Required body `ImportRunManifest`: `{ id: UUID, clientPartyId: UUID, totalRows: integer 1..5000, chunkSize: integer 1..250, chunkHashes: string[] }`. Each hash is lowercase SHA-256 hex (`^[0-9a-f]{64}$`); array length MUST equal `ceil(totalRows/chunkSize)`. Unknown properties are rejected. The frontend creates and persists `id` BEFORE sending. Server normalizes UUIDs to lowercase. 201 ImportRunDetail on first create; 200 current ImportRunDetail for same ID and identical manifest. 409 `IMPORT_MANIFEST_CONFLICT` for changed manifest; 400 invalid manifest; 403 unauthorized scope.
- `GET /invoice-import-runs/{id}`, operationId `getInvoiceImportRun`. UUID path. 200 ImportRunDetail; generic 404 for unknown/inaccessible run. Use this after refresh/network loss to discover the authoritative checkpoint and completed results.
- `POST /invoice-import-runs/{id}/chunks/{chunkIndex}`, operationId `commitInvoiceImportChunk`. UUID path and zero-based integer `chunkIndex` 0..4999, additionally bounded by the manifest. Required body `{ rows: InvoiceImportRow[] }`, 1..250 rows. Unknown fields in the envelope or individual row are rejected. Expected count is `min(chunkSize,totalRows-chunkIndex*chunkSize)`. Row order and `rowNumber` must be exactly `chunkIndex*chunkSize+1` through that range's end, starting from 1 for the first data row (exclude the spreadsheet header). Hash is SHA-256 of canonical JSON of this rows array: recursively sorted object keys, JSON serialization, preserve array order; omit undefined optional fields. Values are NOT trimmed/coerced by the manifest protocol. See `operationPayloadHash`/manifest tests for the exact algorithm.
- Chunk requests need no separately generated key: the server uses `${runId}:${chunkIndex}` under command `invoice.import`. Optional header `X-Idempotency-Key`, if supplied, MUST equal that exact value. 200 ImportRunChunkResponse: `{ runId: UUID, chunkIndex: integer, nextChunkIndex: integer, result: ImportInvoicesResponse }`. `X-Operation-Id` and `Idempotency-Replayed` headers are returned. Exact original body/status are replayed, including the checkpoint at ORIGINAL execution time; GET the run for its current checkpoint. 409 `IMPORT_CHUNK_CONFLICT` for changed hash, `IMPORT_CHECKPOINT_CONFLICT` for a future chunk; 400 `INVALID_CHUNK_ROWS` for count/order/index mismatch; generic 404 for unknown/inaccessible run. A mixed/all-invalid chunk is still HTTP 200 with its durable row outcomes; it advances the checkpoint because every row was processed. To fix rejected rows, start a new intentional run; never mutate the old manifest.
- `POST /invoice-import-runs/{id}/finalize`, operationId `finalizeInvoiceImportRun`. UUID path, optional empty body `{}` (unknown fields rejected). 200 ImportRunDetail with status `completed` and aggregate result. Idempotent on repeat; never calls the importer or creates invoices. 409 `IMPORT_INCOMPLETE` until all chunks have committed. Generic 404 for unknown/inaccessible run.

### ImportRunDetail schema

All fields required, unless explicitly nullable:

```ts
{
  id: string; // UUID, persisted client intent ID
  clientPartyId: string; // UUID, current authorized supplier
  manifestHash: string; // lowercase SHA-256 of the complete normalized manifest
  totalRows: number; // integer 1..5000
  chunkSize: number; // integer 1..250
  chunkHashes: string[];
  nextChunkIndex: number; // next missing zero-based chunk, or chunkHashes.length
  status: "open" | "ready" | "completed";
  committedRows: number; // processed row count, including invalid rows
  createdCount: number;
  invalidCount: number;
  createdAt: string; // date-time
  updatedAt: string; // date-time
  finalizedAt: string | null; // date-time
  chunks: Array<{
    chunkIndex: number;
    operationId: string; // UUID
    rowCount: number;
    result: ImportInvoicesResponse;
  }>;
  result: ImportInvoicesResponse | null; // non-null only after finalize
}
```

`ready` means all chunks are committed but finalization has not been recorded. Aggregate row results are sorted by original rowNumber. Total persisted rows per run never exceeds 5000. GET acquires a short shared run lock so checkpoint metadata and returned chunks cannot describe different commits. The operation recovery API's `invoice.import` result body may now be an ordinary ImportInvoicesResponse OR ImportRunChunkResponse; document both in generated response schemas.

Frontend workflow: persist manifest + random run ID, POST it (retry safely with the identical ID), GET checkpoint, send chunk at `nextChunkIndex`, retain exact rows/key across retry, repeat, finalize, show saved aggregate results. Associate each local journal entry with command `invoice.import` and idempotencyKey `${runId}:${chunkIndex}`. Hash-only run IDs would collapse two intentional identical imports; do not use them.

## Verification

Targeted tests live beside the operations modules, in `routes/operations.test.ts`, and beside the shared journal/status components. PostgreSQL tests require a disposable initialized `DATABASE_URL` with existing baseline schema/role; they apply migration 0051 idempotently and use unique fixture IDs. Never aim them at a customer database. Run with the existing test runtimes; dependency installation belongs to the parent.

Resumable-import tests additionally apply migration 0054. The standalone pure/HTTP tests pass without a database. The two PostgreSQL suites are deliberately skipped when `DATABASE_URL` is absent; a skipped suite is not evidence that lock, RLS, checkpoint-trigger or crash-recovery behavior has been executed. The source-based scoped TypeScript check, ESLint, shared web-ui suite and architecture check have been run. Full workspace build/codegen integration belongs to the parent.

All three Drizzle tables explicitly enable RLS and declare the migration's owner policy with identical USING/WITH CHECK expressions. Foreign-key names match PostgreSQL's migration-created names; checks and indexes match as well. `modules/operations/schema.test.ts` checks schema/migration parity without opening a database. FORCE RLS, grants and deferred/immutable triggers still require migrations 0051/0054, not schema inference or push.

The requested core regression additions in `modules/invoice/import.test.ts` cover all-invalid bulk batches of 101, 250 and 5000 rows while forbidding SQL, plus database cases for 2/102/502-row failures and the one-valid-row/all-buyers-existing case. The 502-row case fails after the first 500-row insert batch so fallback must not retain those invoices, lines or cached buyer IDs. Database cases are skipped without `DATABASE_URL`; pure validation and the no-SQL regression still execute.

The fragment `docs/operations-r198-openapi.yaml` contains only paths/components and references existing InvoiceDetail, InvoiceImportRow, InvoiceImportResult and Error schemas. Its references have been checked against an in-memory structural merge with the current spec. Use the named `ImportRunFinalizeInput` schema to avoid an Orval `FinalizeInvoiceImportRunBody` value/type export collision.

### Parent review follow-up

The current shared `withTransaction` helper creates a child context with a separate `active` flag. Child contexts must also validate their parent context's lifetime: an outer HTTP timeout/disconnect can otherwise roll back/release the connection while a still-running nested importer sees `active:true`. The operation/run services revalidate their ambient handle before each continuation query, but the shared helper must protect nested import/row-lock work itself. Add a timeout test that suspends a child, ends the outer request transaction, resumes the child and proves no SQL can execute. The parent has now added the explicit operator/auditor/bank/buyer 403 guard to draft recovery.

Import buyer concurrency is now scoped inside `modules/invoice/import.ts`: every committed import containing valid rows opens an ambient savepoint and acquires one transaction-scoped advisory lock for `(firmId, supplierPartyId)` BEFORE any buyer lookup. Both per-row and bulk strategies share this boundary; bulk fallback calls the internal row engine without releasing/reacquiring the supplier lock. One lock avoids opposite-TIN ordering and retains protection across row/savepoint rollback. Existing HTTP/run callers process one supplier per request transaction. Different suppliers proceed independently; this intentionally serializes even disjoint TIN batches for the same supplier, trading some import parallelism for simple lock ordering. READ COMMITTED is checked explicitly so the post-lock lookup sees a committed winner; stronger snapshot isolation is rejected before buyer work.

Parties are a shared table without tenant RLS, so lookup now uses the narrower supplier sphere: the supplier itself, same-firm parties captured by the current human actor, or parties on this firm's invoices for that supplier. It excludes merged records and chooses the oldest visible legacy match consistently in both strategies. New buyers record firm and human-actor provenance; API-key actors do not populate the UUID user field. The bulk cache is local to the failed savepoint and discarded before fallback; per-row buyers are re-read inside their own savepoint. Missing-buyer inserts are size-guarded, and invoice/line/event inserts only run on nonempty chunks. No legacy party is deleted, merged, renumbered or constrained uniquely.

Exact residual: direct `createParty`/party updates and the connector engine's separate `findOrCreateBuyer` do not participate in the invoice-import lock protocol and may still create a same-TIN party concurrently. They were inspected but not edited. Cross-supplier or cross-firm equal TINs may legitimately remain separate because visibility is scoped; the importer must not reveal/reuse a hidden match. A caller that wants to process multiple suppliers inside one outer transaction must establish a consistent supplier-lock order first; existing import routes and run chunks each use one supplier. The regression suite includes SQL lock-wait checks for concurrent small/bulk/reversed-order imports, bulk fallback, outer rollback, and cross-firm/client visibility. Those PostgreSQL cases require `DATABASE_URL` and have not been executed in this environment.

### Exact scoped files

```text
artifacts/api-server/src/modules/operations/command.ts
artifacts/api-server/src/modules/operations/command.test.ts
artifacts/api-server/src/modules/operations/http.ts
artifacts/api-server/src/modules/operations/service.ts
artifacts/api-server/src/modules/operations/service.test.ts
artifacts/api-server/src/modules/operations/schema.test.ts
artifacts/api-server/src/modules/import-runs/manifest.ts
artifacts/api-server/src/modules/import-runs/manifest.test.ts
artifacts/api-server/src/modules/import-runs/service.ts
artifacts/api-server/src/modules/import-runs/service.test.ts
artifacts/api-server/src/modules/invoice/import.test.ts
artifacts/api-server/src/modules/invoice/import.ts
artifacts/api-server/src/routes/operations.ts
artifacts/api-server/src/routes/operations.test.ts
artifacts/api-server/src/routes/import-runs.ts
artifacts/api-server/src/routes/import-runs.test.ts
lib/db/src/schema/operations.ts
lib/db/src/schema/import-runs.ts
lib/db/src/migrations/0051_operation_recovery.ts
lib/db/src/migrations/0054_import_runs.ts
lib/web-ui/src/operation-journal.ts
lib/web-ui/src/operation-journal.test.ts
lib/web-ui/src/operation-status.tsx
lib/web-ui/src/operation-status.test.tsx
docs/operations-r198-contract.md
docs/operations-r198-openapi.yaml
```
