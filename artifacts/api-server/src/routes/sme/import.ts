import { Router, type IRouter } from "express";
import { ImportInvoicesBody, ImportInvoicesResponse } from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  assertPartyAccess,
  requireFirmScope,
} from "../../modules/auth/rbac";
import { importInvoices } from "../../modules/invoice/import";
import { executeHttpOperation } from "../../modules/operations/http";
import { importOperationOutcome } from "../../modules/operations/command";

const router: IRouter = Router();

// Hard cap on a single import (NFR-03 budgets ~5,000 rows). Bounds the work a
// single authenticated request can do inside one DB transaction (SEC-M3); the
// 8mb body limit alone would otherwise admit tens of thousands of rows.
const MAX_IMPORT_ROWS = 5000;

// The route keeps auth/scope/size gating and the contract parse; the import
// engine itself (row validation, buyer resolution, the per-row and bulk
// commit strategies) lives in modules/invoice/import.ts.
router.post("/invoices/import", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const parsed = parseOrThrow(ImportInvoicesBody, req.body);
  const { clientPartyId, rows } = parsed;
  const commit = parsed.commit ?? false;
  if (rows.length > MAX_IMPORT_ROWS) {
    res.status(413).json({
      error: `Too many rows: ${rows.length} exceeds the ${MAX_IMPORT_ROWS}-row import limit`,
    });
    return;
  }
  await assertPartyAccess(req.principal, clientPartyId);
  const firmId = requireFirmScope(req.principal);
  const execute = async () =>
    ImportInvoicesResponse.parse(
      await importInvoices(
        firmId,
        clientPartyId,
        rows,
        commit,
        req.principal.userId,
      ),
    );
  if (!commit) {
    res.json(await execute());
    return;
  }
  await executeHttpOperation(req, res, {
    command: "invoice.import",
    clientPartyId,
    payload: { ...parsed, commit },
    execute: async () => {
      const body = await execute();
      return { statusCode: 200, body, ...importOperationOutcome(body) };
    },
  });
});

export default router;
