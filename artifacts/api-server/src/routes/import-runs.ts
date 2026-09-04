import { Router, type IRouter } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/parse";
import { DomainError } from "../modules/errors";
import {
  ImportRunChunkBody,
  ImportRunManifestBody,
} from "../modules/import-runs/manifest";
import {
  createImportRun,
  executeImportRunChunk,
  finalizeImportRun,
  getImportRun,
} from "../modules/import-runs/service";

const router: IRouter = Router();
const RunParams = z.object({
  id: z
    .string()
    .uuid()
    .transform((id) => id.toLowerCase()),
});
router.use("/invoice-import-runs", (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

router.post("/invoice-import-runs", async (req, res) => {
  const result = await createImportRun(
    req.principal,
    parseOrThrow(ImportRunManifestBody, req.body),
  );
  res.status(result.created ? 201 : 200).json(result.run);
});

router.get("/invoice-import-runs/:id", async (req, res) => {
  const { id } = parseOrThrow(RunParams, req.params);
  res.json(await getImportRun(req.principal, id));
});

router.post("/invoice-import-runs/:id/chunks/:chunkIndex", async (req, res) => {
  const { id, chunkIndex } = parseOrThrow(
    RunParams.extend({ chunkIndex: z.coerce.number().int().min(0).max(4999) }),
    req.params,
  );
  const { rows } = parseOrThrow(ImportRunChunkBody, req.body);
  const expectedKey = `${id}:${chunkIndex}`;
  if (
    req.headers["x-idempotency-key"] !== undefined &&
    req.headers["x-idempotency-key"] !== expectedKey
  ) {
    throw new DomainError(
      "INVALID_IDEMPOTENCY_KEY",
      "Chunk X-Idempotency-Key must equal runId:chunkIndex",
      400,
    );
  }
  const result = await executeImportRunChunk(
    req.principal,
    id,
    chunkIndex,
    rows,
  );
  res.setHeader("X-Operation-Id", result.operationId);
  res.setHeader("Idempotency-Replayed", String(result.replayed));
  res.status(result.statusCode).type("application/json").send(result.body);
});

router.post("/invoice-import-runs/:id/finalize", async (req, res) => {
  const { id } = parseOrThrow(RunParams, req.params);
  parseOrThrow(z.object({}).strict(), req.body ?? {});
  res.json(await finalizeImportRun(req.principal, id));
});

export default router;
