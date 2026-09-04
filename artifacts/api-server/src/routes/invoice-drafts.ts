import { Router, type IRouter } from "express";
import { parseOrThrow } from "../lib/parse";
import {
  DraftDeleteBody,
  DraftListQuery,
  DraftParams,
  DraftScopeQuery,
  DraftWriteBody,
} from "../modules/invoice-drafts/contract";
import {
  deleteInvoiceDraft,
  getInvoiceDraft,
  listInvoiceDrafts,
  saveInvoiceDraft,
} from "../modules/invoice-drafts/service";

const router: IRouter = Router();
router.use("/invoice-drafts", (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});
router.get("/invoice-drafts", async (req, res) => {
  const query = parseOrThrow(DraftListQuery, req.query);
  res.setHeader("Cache-Control", "no-store");
  res.json(
    await listInvoiceDrafts(req.principal, query.clientPartyId, query.offset),
  );
});
router.get("/invoice-drafts/:id", async (req, res) => {
  const { id } = parseOrThrow(DraftParams, req.params);
  const query = parseOrThrow(DraftScopeQuery, req.query);
  res.setHeader("Cache-Control", "no-store");
  res.json(await getInvoiceDraft(req.principal, query.clientPartyId, id));
});
router.put("/invoice-drafts/:id", async (req, res) => {
  const { id } = parseOrThrow(DraftParams, req.params);
  const body = parseOrThrow(DraftWriteBody, req.body);
  res.setHeader("Cache-Control", "no-store");
  res.json(await saveInvoiceDraft(req.principal, id, body));
});
router.delete("/invoice-drafts/:id", async (req, res) => {
  const { id } = parseOrThrow(DraftParams, req.params);
  const body = parseOrThrow(DraftDeleteBody, req.body);
  await deleteInvoiceDraft(
    req.principal,
    body.clientPartyId,
    id,
    body.expectedRevision,
  );
  res.sendStatus(204);
});
export default router;
