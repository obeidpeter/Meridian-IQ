import { Router, type IRouter } from "express";
import { VerifyAuditResponse, ExportAuditResponse } from "@workspace/api-zod";
import { assertCan } from "../modules/auth/rbac";
import { verifyChain, exportAuditBundle } from "../modules/audit/audit";
import { sendCsvAttachment, toCsv } from "../lib/csv";

const router: IRouter = Router();

router.get("/audit/verify", async (req, res): Promise<void> => {
  assertCan(req.principal, "audit.read");
  res.json(VerifyAuditResponse.parse(await verifyChain()));
});

router.get("/audit/export", async (req, res): Promise<void> => {
  assertCan(req.principal, "audit.export");
  res.json(ExportAuditResponse.parse(await exportAuditBundle()));
});

// Spreadsheet-friendly companion to the JSON bundle: the same ledger, one row
// per event, hashes included so a row can still be spot-checked against the
// verifiable bundle. Auditors who live in Excel start here.
router.get("/audit/export/csv", async (req, res): Promise<void> => {
  assertCan(req.principal, "audit.export");
  const { events, verification } = await exportAuditBundle();
  const csv = toCsv(
    [
      "seq",
      "created_at",
      "actor_id",
      "actor_role",
      "firm_id",
      "action",
      "entity_type",
      "entity_id",
      "prev_hash",
      "hash",
    ],
    events.map((e) => [
      e.seq,
      e.createdAt.toISOString(),
      e.actorId ?? "",
      e.actorRole ?? "",
      e.firmId ?? "",
      e.action,
      e.entityType,
      e.entityId,
      e.prevHash,
      e.hash,
    ]),
  );
  // Chain state rides along as a response header, not a CSV row, so the file
  // stays strictly tabular.
  res.setHeader("X-Audit-Chain-Valid", String(verification.valid));
  sendCsvAttachment(
    res,
    `meridianiq-audit-ledger-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
  );
});

export default router;
