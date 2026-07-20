import { Router, type IRouter } from "express";
import {
  CreateClerkBatchBody,
  CreateClerkBatchResponse,
  ListClerkBatchesResponse,
  GetClerkBatchParams,
  GetClerkBatchResponse,
} from "@workspace/api-zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb, clerkBatchesTable, type ClerkBatch } from "@workspace/db";
import { parseOrThrow } from "../../lib/parse";
import { assertCan, tenantFirmId } from "../../modules/auth/rbac";
import { assertFirmClerkBudget } from "../../modules/clerk/budget";
import {
  createClerkBatch,
  kickBatchProcessing,
  reviewedCounts,
} from "../../modules/clerk/batch-async";

const router: IRouter = Router();

// ---- Async batch intake (idea #8) ----
// The route only QUEUES: no model call happens in the request. Processing
// starts immediately in-process and is guaranteed by the sweep (reclaim on
// crash); the UI polls the batch row's progress counters.

const stripBatch = (b: ClerkBatch) => ({
  id: b.id,
  firmId: b.firmId,
  name: b.name,
  kind: b.sourceKind,
  status: b.status,
  totalSegments: b.totalSegments,
  processedSegments: b.processedSegments,
  createdCases: b.createdCases,
  skippedDuplicates: b.skippedDuplicates,
  failReason: b.failReason,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});


router.post("/clerk/batches", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const parsed = parseOrThrow(CreateClerkBatchBody, req.body);
  // Budget gate covers the segmentation + extractions the processor will run;
  // an exhausted firm gets a clean 429 before anything is queued.
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const batch = await createClerkBatch(parsed, req.principal.userId, {
    firmId: tenant,
  });
  kickBatchProcessing(batch.id);
  res.status(202).json(
    CreateClerkBatchResponse.parse({ ...stripBatch(batch), reviewedCases: 0 }),
  );
});

router.get("/clerk/batches", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const tenant = tenantFirmId(req.principal);
  const conditions = [];
  if (tenant) conditions.push(eq(clerkBatchesTable.firmId, tenant));
  if (req.principal.role === "client_user") {
    conditions.push(eq(clerkBatchesTable.createdBy, req.principal.userId));
  }
  const rows = await getDb()
    .select()
    .from(clerkBatchesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(clerkBatchesTable.createdAt))
    .limit(50);
  const reviewed = await reviewedCounts(rows.map((r) => r.id));
  res.json(
    ListClerkBatchesResponse.parse(
      rows.map((r) => ({
        ...stripBatch(r),
        reviewedCases: reviewed.get(r.id) ?? 0,
      })),
    ),
  );
});

router.get("/clerk/batches/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const params = parseOrThrow(GetClerkBatchParams, req.params);
  const [row] = await getDb()
    .select()
    .from(clerkBatchesTable)
    .where(eq(clerkBatchesTable.id, params.id))
    .limit(1);
  // Same 404 posture as cases: firm principals only their firm's batches, a
  // client_user only its own submissions; existence is never disclosed.
  const tenant = tenantFirmId(req.principal);
  if (
    !row ||
    (tenant && row.firmId !== tenant) ||
    (req.principal.role === "client_user" &&
      row.createdBy !== req.principal.userId)
  ) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }
  const reviewed = await reviewedCounts([row.id]);
  res.json(
    GetClerkBatchResponse.parse({
      ...stripBatch(row),
      reviewedCases: reviewed.get(row.id) ?? 0,
    }),
  );
});

export default router;
