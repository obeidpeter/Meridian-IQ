import { Router, type IRouter } from "express";
import { and, desc, isNotNull, notInArray, sql } from "drizzle-orm";
import { getDb, submissionAttemptsTable, errorCatalogueTable } from "@workspace/db";
import {
  ListErrorCatalogueResponse,
  GetErrorCatalogueEntryParams,
  GetErrorCatalogueEntryResponse,
  UpsertErrorCatalogueEntryBody,
  UpsertErrorCatalogueEntryResponse,
  UpdateErrorCatalogueEntryParams,
  UpdateErrorCatalogueEntryBody,
  UpdateErrorCatalogueEntryResponse,
  ListUnmappedErrorCodesResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { assertCan } from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";
import {
  listCatalogue,
  getCatalogueEntry,
  upsertCatalogueEntry,
  updateCatalogueEntry,
} from "../modules/catalogue/catalogue";

const router: IRouter = Router();

// ADV-03. Reads are open to any authenticated principal because the catalogue
// is reused across every surface as in-app help; writes require catalogue.write
// (operator only), so operators can edit an entry within a working day.

router.get("/error-catalogue", async (_req, res): Promise<void> => {
  const rows = await listCatalogue();
  res.json(ListErrorCatalogueResponse.parse(rows));
});

// INT-02: failure codes observed on submission attempts that have no catalogue
// entry — the operator's to-do list for keeping the unmapped rate under 2%.
// Must register before /error-catalogue/:code or "unmapped" is read as a code.
router.get("/error-catalogue/unmapped", async (req, res): Promise<void> => {
  assertCan(req.principal, "catalogue.write");
  const known = getDb()
    .select({ code: errorCatalogueTable.code })
    .from(errorCatalogueTable);
  const rows = await getDb()
    .select({
      code: submissionAttemptsTable.errorCode,
      occurrences: sql<number>`count(*)::int`,
      lastSeenAt: sql<Date>`max(${submissionAttemptsTable.createdAt})`,
    })
    .from(submissionAttemptsTable)
    .where(
      and(
        isNotNull(submissionAttemptsTable.errorCode),
        notInArray(submissionAttemptsTable.errorCode, known),
      ),
    )
    .groupBy(submissionAttemptsTable.errorCode)
    .orderBy(desc(sql`max(${submissionAttemptsTable.createdAt})`));
  res.json(
    ListUnmappedErrorCodesResponse.parse(
      rows.map((r) => ({
        code: r.code as string,
        occurrences: r.occurrences,
        lastSeenAt: r.lastSeenAt,
      })),
    ),
  );
});

router.get("/error-catalogue/:code", async (req, res): Promise<void> => {
  const params = parseOrThrow(GetErrorCatalogueEntryParams, req.params);
  const entry = await getCatalogueEntry(params.code);
  if (!entry) {
    res.status(404).json({ error: "Catalogue entry not found" });
    return;
  }
  res.json(GetErrorCatalogueEntryResponse.parse(entry));
});

router.post("/error-catalogue", async (req, res): Promise<void> => {
  assertCan(req.principal, "catalogue.write");
  const parsed = parseOrThrow(UpsertErrorCatalogueEntryBody, req.body);
  const entry = await upsertCatalogueEntry(parsed, req.principal.userId);
  await appendAudit({
    actorId: req.principal.userId,
    action: "catalogue.upsert",
    entityType: "error_catalogue",
    entityId: entry.code,
    after: { cause: entry.cause, fix: entry.fix, retriable: entry.retriable },
  });
  res.status(201).json(UpsertErrorCatalogueEntryResponse.parse(entry));
});

router.patch("/error-catalogue/:code", async (req, res): Promise<void> => {
  assertCan(req.principal, "catalogue.write");
  const params = parseOrThrow(UpdateErrorCatalogueEntryParams, req.params);
  const parsed = parseOrThrow(UpdateErrorCatalogueEntryBody, req.body);
  const entry = await updateCatalogueEntry(
    params.code,
    parsed,
    req.principal.userId,
  );
  if (!entry) {
    res.status(404).json({ error: "Catalogue entry not found" });
    return;
  }
  await appendAudit({
    actorId: req.principal.userId,
    action: "catalogue.update",
    entityType: "error_catalogue",
    entityId: entry.code,
    after: { cause: entry.cause, fix: entry.fix, retriable: entry.retriable },
  });
  res.json(UpdateErrorCatalogueEntryResponse.parse(entry));
});

export default router;
