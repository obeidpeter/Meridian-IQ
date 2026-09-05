import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { parseOrThrow } from "../lib/parse";
import {
  listExpiredClerkReservations,
  reconcileExpiredClerkReservation,
} from "../modules/clerk/budget-recovery";

const router: IRouter = Router();
const query = z.object({
  afterId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const body = z
  .object({
    reason: z.string().trim().min(10).max(1_000),
    confirmedStopped: z.literal(true),
    chargedTokens: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict();

router.get("/operator/clerk-reservations", async (req, res) => {
  const input = parseOrThrow(query, req.query);
  const rows = await listExpiredClerkReservations(
    req.principal,
    input.afterId,
    input.limit,
  );
  res.json({
    reservations: rows,
    nextAfterId: rows.length === input.limit ? rows[rows.length - 1]?.id : null,
  });
});

router.post("/operator/clerk-reservations/:id/reconcile", async (req, res) => {
  const { id } = parseOrThrow(z.object({ id: z.string().uuid() }), req.params);
  res.json(
    await reconcileExpiredClerkReservation(
      req.principal,
      id,
      parseOrThrow(body, req.body),
    ),
  );
});

export default router;
