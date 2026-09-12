import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import {
  AssistEvidenceRequestBody,
  AssistEvidenceRequestParams,
  AssistEvidenceRequestResponse,
  CreateEvidenceRequestBody,
  CreateEvidenceRequestResponse,
  DownloadEvidenceFileParams,
  DownloadEvidencePackParams,
  GetEvidenceRequestParams,
  GetEvidenceRequestResponse,
  ListEvidenceRequestsQueryParams,
  ListEvidenceRequestsResponse,
  RetryEvidenceScanBody,
  RetryEvidenceScanParams,
  RetryEvidenceScanResponse,
  ReviewEvidenceRequestBody,
  ReviewEvidenceRequestParams,
  ReviewEvidenceRequestResponse,
  UploadEvidenceFileBody,
  UploadEvidenceFileParams,
  UploadEvidenceFileResponse,
  UpdateEvidenceRequestBody,
  UpdateEvidenceRequestParams,
  UpdateEvidenceRequestResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { assertCan } from "../modules/auth/rbac";
import { assistEvidenceRequest } from "../modules/evidence/assistance";
import { readEvidenceFile } from "../modules/evidence/files";
import { exportEvidencePack } from "../modules/evidence/packs";
import { createEvidenceRequest } from "../modules/evidence/requests";
import { retryEvidenceScan } from "../modules/evidence/retry-scan";
import { reviewEvidenceRequest } from "../modules/evidence/reviews";
import { uploadEvidenceFile } from "../modules/evidence/uploads";
import { updateEvidenceRequest } from "../modules/evidence/update-request";
import {
  evidenceDetail,
  listEvidenceRequests,
} from "../modules/evidence/views";

const router: IRouter = Router();

router.use("/evidence", (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

router.get("/evidence/requests", async (req, res): Promise<void> => {
  const query = parseOrThrow(
    ListEvidenceRequestsQueryParams.extend({
      offset: z.coerce.number().int().min(0).max(5000).default(0),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }).strict(),
    req.query,
  );
  res.json(
    ListEvidenceRequestsResponse.parse(
      await listEvidenceRequests(req.principal, query),
    ),
  );
});

router.post("/evidence/requests", async (req, res): Promise<void> => {
  const body = parseOrThrow(
    CreateEvidenceRequestBody.extend({
      dueAt: z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value))
        .optional(),
    }).strict(),
    req.body,
  );
  const result = await createEvidenceRequest(req.principal, {
    ...body,
    dueAt: body.dueAt?.toISOString(),
  });
  res.status(201).json(CreateEvidenceRequestResponse.parse(result));
});

router.get("/evidence/requests/:id", async (req, res): Promise<void> => {
  const { id } = parseOrThrow(GetEvidenceRequestParams, req.params);
  res.json(
    GetEvidenceRequestResponse.parse(await evidenceDetail(req.principal, id)),
  );
});

router.patch("/evidence/requests/:id", async (req, res): Promise<void> => {
  const { id } = parseOrThrow(UpdateEvidenceRequestParams, req.params);
  const body = parseOrThrow(
    UpdateEvidenceRequestBody.extend({
      expectedVersion: z.number().int().min(1),
      dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
    }).strict(),
    req.body,
  );
  res.json(
    UpdateEvidenceRequestResponse.parse(
      await updateEvidenceRequest(req.principal, id, body),
    ),
  );
});

router.post("/evidence/requests/:id/files", async (req, res): Promise<void> => {
  assertCan(req.principal, "evidence.upload");
  const { id } = parseOrThrow(UploadEvidenceFileParams, req.params);
  const body = parseOrThrow(
    UploadEvidenceFileBody.extend({
      expectedVersion: z.number().int().min(1),
    }).strict(),
    req.body,
  );
  res
    .status(201)
    .json(
      UploadEvidenceFileResponse.parse(
        await uploadEvidenceFile(req.principal, id, body),
      ),
    );
});

router.post(
  "/evidence/requests/:id/review",
  async (req, res): Promise<void> => {
    const { id } = parseOrThrow(ReviewEvidenceRequestParams, req.params);
    const body = parseOrThrow(
      ReviewEvidenceRequestBody.extend({
        expectedVersion: z.number().int().min(1),
      }).strict(),
      req.body,
    );
    res.json(
      ReviewEvidenceRequestResponse.parse(
        await reviewEvidenceRequest(req.principal, id, body),
      ),
    );
  },
);

function sendAttachment(
  res: Response,
  bytes: Buffer,
  contentType: string,
  filename: string,
): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.attachment(filename);
  res.send(bytes);
}

router.get("/evidence/files/:id/download", async (req, res): Promise<void> => {
  const { id } = parseOrThrow(DownloadEvidenceFileParams, req.params);
  const { file, bytes } = await readEvidenceFile(req.principal, id);
  sendAttachment(res, bytes, file.contentType, file.filename);
});

router.post("/evidence/files/:id/scan", async (req, res): Promise<void> => {
  const { id } = parseOrThrow(RetryEvidenceScanParams, req.params);
  const body = parseOrThrow(RetryEvidenceScanBody.strict(), req.body);
  res.json(
    RetryEvidenceScanResponse.parse(
      await retryEvidenceScan(req.principal, id, body.clientRequestId),
    ),
  );
});

router.post(
  "/evidence/requests/:id/assist",
  async (req, res): Promise<void> => {
    const { id } = parseOrThrow(AssistEvidenceRequestParams, req.params);
    const body = parseOrThrow(AssistEvidenceRequestBody.strict(), req.body);
    res.json(
      AssistEvidenceRequestResponse.parse(
        await assistEvidenceRequest(req.principal, id, body),
      ),
    );
  },
);

router.get("/evidence/requests/:id/pack", async (req, res): Promise<void> => {
  const { id } = parseOrThrow(DownloadEvidencePackParams, req.params);
  const pack = await exportEvidencePack(req.principal, id);
  sendAttachment(res, pack.bytes, pack.contentType, pack.filename);
});

export default router;
