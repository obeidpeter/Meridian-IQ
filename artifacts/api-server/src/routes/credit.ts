import { Router, type IRouter } from "express";
import {
  GetBankDataRoomResponse,
  GetCollectionFeedSpecificationResponse,
  GetCreditGovernanceResponse,
  ListBankDataRoomAccessQueryParams,
  ListBankDataRoomAccessResponse,
  RecordBankDataRoomAccessBody,
  RecordBankDataRoomAccessResponse,
  RecordCreditKybCheckBody,
  RecordCreditKybCheckResponse,
  RunCreditAssessmentBody,
  RunCreditAssessmentResponse,
  RunCreditBacktestBody,
  RunCreditBacktestResponse,
} from "@workspace/api-zod";
import { pageBounds } from "../lib/page";
import { parseOrThrow } from "../lib/parse";
import { assertCan } from "../modules/auth/rbac";
import {
  getBankDataRoom,
  listBankDataRoomAccess,
} from "../modules/credit/data-room";
import { COLLECTION_ACCOUNT_FEED_SPECIFICATION } from "../modules/credit/feed-spec";
import { getCreditGovernance } from "../modules/credit/governance";
import {
  recordBankAccess,
  recordKybCheck,
  runEligibilityAssessment,
  runStructuralBacktest,
} from "../modules/credit/service";
import { requireFlag } from "../modules/flags/flags";

const router: IRouter = Router();

router.get("/operator/credit/governance", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  res.json(GetCreditGovernanceResponse.parse(await getCreditGovernance()));
});

router.post(
  "/operator/credit/assessments/run",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "operator.queue.act");
    const body = parseOrThrow(RunCreditAssessmentBody, req.body);
    const result = await runEligibilityAssessment(req.principal, body);
    res.status(201).json(RunCreditAssessmentResponse.parse(result));
  },
);

router.post("/operator/credit/kyb-checks", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const body = parseOrThrow(RecordCreditKybCheckBody, req.body);
  const result = await recordKybCheck(req.principal, {
    ...body,
    checkedAt: body.checkedAt.toISOString(),
    expiresAt: body.expiresAt.toISOString(),
  });
  res.status(201).json(RecordCreditKybCheckResponse.parse(result));
});

router.post("/operator/credit/bank-access", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const body = parseOrThrow(RecordBankDataRoomAccessBody, req.body);
  const result = await recordBankAccess(req.principal, {
    ...body,
    dpaExecutedAt: body.dpaExecutedAt?.toISOString() ?? null,
    validUntil: body.validUntil?.toISOString() ?? null,
  });
  res.status(201).json(RecordBankDataRoomAccessResponse.parse(result));
});

router.post("/operator/credit/backtests", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const body = parseOrThrow(RunCreditBacktestBody, req.body);
  const result = await runStructuralBacktest(req.principal, {
    fromDate: body.fromDate.toISOString().slice(0, 10),
    toDate: body.toDate.toISOString().slice(0, 10),
    idempotencyKey: body.idempotencyKey,
  });
  res.status(201).json(RunCreditBacktestResponse.parse(result));
});

router.get(
  "/operator/credit/collection-feed-specification",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "operator.queue.read");
    res.json(
      GetCollectionFeedSpecificationResponse.parse(
        COLLECTION_ACCOUNT_FEED_SPECIFICATION,
      ),
    );
  },
);

// The bank surface is fixed-query and never cacheable. The global feature
// gate must be active, then the service independently verifies role, MFA,
// latest access grant, DPA and expiry before touching aggregate data.
router.get(
  "/credit/data-room",
  requireFlag("bank_data_room", { global: true }),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "credit.data_room.read");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.json(
      GetBankDataRoomResponse.parse(await getBankDataRoom(req.principal)),
    );
  },
);

router.get(
  "/credit/data-room/access-log",
  requireFlag("bank_data_room", { global: true }),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "credit.data_room.read");
    const query = parseOrThrow(ListBankDataRoomAccessQueryParams, req.query);
    const bounds = pageBounds(query, { defaultLimit: 50, maxLimit: 100 });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.json(
      ListBankDataRoomAccessResponse.parse(
        await listBankDataRoomAccess(req.principal, bounds.limit),
      ),
    );
  },
);

export default router;
