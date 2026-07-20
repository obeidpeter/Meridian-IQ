import { Router, type IRouter } from "express";
import {
  VerifyAuditResponse,
  ExportAuditResponse,
  ExportFirmDataParams,
  ExportFirmDataResponse,
} from "@workspace/api-zod";
import { assertCan } from "../modules/auth/rbac";
import { appendAudit, verifyChain, exportAuditBundle } from "../modules/audit/audit";
import { exportFirmData } from "../modules/audit/firm-export";
import { DomainError } from "../modules/errors";
import { parseOrThrow } from "../lib/parse";
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

// Full-firm portability export. audit.export is held by exactly operator and
// auditor (rbac.ts: operator explicitly; auditor via READ_ONLY, which
// deliberately includes audit.export as its one non-.read capability — an
// export IS a read). The role check below pins that: a future capability
// grant to a firm role must not silently open a cross-tenant bundle through
// this route. Both roles run in the RLS-bypass tenant context (app.ts
// BYPASS_ROLES), which the cross-firm section queries require.
router.get("/firms/:id/export", async (req, res): Promise<void> => {
  assertCan(req.principal, "audit.export");
  if (req.principal.role !== "operator" && req.principal.role !== "auditor") {
    throw new DomainError(
      "FORBIDDEN",
      "Firm export is limited to platform operators and auditors",
      403,
    );
  }
  const params = parseOrThrow(ExportFirmDataParams, req.params);
  const bundle = await exportFirmData(params.id); // 404 when the firm does not exist
  // Audit the export itself, pointer-only (section row counts, never
  // content), AFTER assembling the bundle so an export never contains its own
  // event.
  await appendAudit({
    actorId: req.principal.userId,
    actorRole: req.principal.role,
    firmId: params.id,
    action: "audit.firm_export",
    entityType: "firm",
    entityId: params.id,
    after: {
      sections: Object.fromEntries(bundle.counts.map((c) => [c.section, c.rows])),
      truncated: bundle.counts.filter((c) => c.truncated).map((c) => c.section),
    },
  });
  res.json(ExportFirmDataResponse.parse(bundle));
});

export default router;
