import { Router, type IRouter } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/parse";
import {
  listOperations,
  recoverOperation,
} from "../modules/operations/service";

const router: IRouter = Router();
router.use("/operations", (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

router.get("/operations", async (req, res) => {
  const query = parseOrThrow(
    z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(256).optional(),
      })
      .strict(),
    req.query,
  );
  res.json(await listOperations(req.principal, query));
});

router.get("/operations/lookup", async (req, res) => {
  const query = parseOrThrow(
    z
      .object({
        command: z.enum(["invoice.create", "invoice.import"]),
        idempotencyKey: z.string().min(1).max(128),
      })
      .strict(),
    req.query,
  );
  res.json(await recoverOperation(req.principal, query));
});

router.get("/operations/:id", async (req, res) => {
  const params = parseOrThrow(z.object({ id: z.string().uuid() }), req.params);
  res.json(await recoverOperation(req.principal, params));
});

export default router;
