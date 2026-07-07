import { Router, type IRouter } from "express";
import { getDb, railStatesTable } from "@workspace/db";
import {
  ListDeadLettersResponse,
  ReplayDeadLetterParams,
  ReconcilePipelineResponse,
  ListRailStatesResponse,
} from "@workspace/api-zod";
import { assertCan } from "../modules/auth/rbac";
import {
  listDeadLetters,
  replayDead,
  reconcile,
} from "../modules/pipeline/pipeline";

const router: IRouter = Router();

router.get("/operator/dead-letters", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  res.json(ListDeadLettersResponse.parse(await listDeadLetters()));
});

router.post(
  "/operator/dead-letters/:id/replay",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "operator.queue.act");
    const params = ReplayDeadLetterParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await replayDead(params.data.id);
    res.sendStatus(204);
  },
);

router.post("/operator/reconcile", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const requeued = await reconcile();
  res.json(ReconcilePipelineResponse.parse({ requeued }));
});

router.get("/operator/rails", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const rows = await getDb().select().from(railStatesTable);
  res.json(ListRailStatesResponse.parse(rows));
});

export default router;
