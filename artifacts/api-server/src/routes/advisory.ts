import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { getDb, engagementsTable } from "@workspace/db";
import {
  GetAssessmentQuestionnaireResponse,
  RunAssessmentBody,
  RunAssessmentResponse,
  GetAssessmentParams,
  GetAssessmentResponse,
  AnalyzeVatRiskBody,
  AnalyzeVatRiskResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import {
  assertCan,
  assertClientPartyScope,
  assertSameTenant,
  requireFirmScope,
} from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";
import {
  getQuestionnaireTemplate,
  computeAssessment,
} from "../modules/advisory/questionnaire";
import { parseLedgerCsv, analyzeLedger } from "../modules/advisory/vatRisk";
import { verifyStampBatch } from "../modules/rails/adapter";

const router: IRouter = Router();

// ADV-01: the readiness-assessment questionnaire template (client-facing kit).
router.get("/assessments/questionnaire", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.read");
  res.json(GetAssessmentQuestionnaireResponse.parse(getQuestionnaireTemplate()));
});

// ADV-01: run an assessment. The gap report + remediation plan are persisted as
// Engagement findings so advisory work lands in the same spine from R0.
router.post("/assessments", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.write");
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(RunAssessmentBody, req.body);
  const result = computeAssessment(parsed.answers);
  const completedAt = new Date();
  const title =
    parsed.title ?? `Readiness assessment (${result.band}, ${result.score}%)`;
  const findings = {
    version: result.version,
    score: result.score,
    band: result.band,
    gaps: result.gaps,
    remediation: result.remediation,
    clientPartyId: parsed.clientPartyId,
    completedAt: completedAt.toISOString(),
  };
  const [row] = await getDb()
    .insert(engagementsTable)
    .values({
      firmId,
      clientPartyId: parsed.clientPartyId,
      type: "readiness_assessment",
      status: "completed",
      title,
      findings,
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "assessment.run",
    entityType: "engagement",
    entityId: row.id,
    after: { score: result.score, band: result.band },
  });
  res.status(201).json(
    RunAssessmentResponse.parse({
      engagementId: row.id,
      clientPartyId: parsed.clientPartyId,
      title,
      score: result.score,
      band: result.band,
      gaps: result.gaps,
      remediation: result.remediation,
      completedAt,
    }),
  );
});

// ADV-01: retrieve a persisted assessment, reconstructed from its findings.
router.get("/assessments/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.read");
  const params = parseOrThrow(GetAssessmentParams, req.params);
  const [row] = await getDb()
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, params.id))
    .limit(1);
  if (!row || row.type !== "readiness_assessment" || !row.findings) {
    res.status(404).json({ error: "Assessment not found" });
    return;
  }
  assertSameTenant(req.principal, row.firmId);
  // SEC-03: a client_user may only read its own client party's assessment,
  // not a sibling client's readiness findings within the same firm.
  assertClientPartyScope(req.principal, row.clientPartyId);
  const f = row.findings as Record<string, unknown>;
  res.json(
    GetAssessmentResponse.parse({
      engagementId: row.id,
      clientPartyId: row.clientPartyId,
      title: row.title,
      score: f.score,
      band: f.band,
      gaps: f.gaps,
      remediation: f.remediation,
      completedAt: f.completedAt,
    }),
  );
});

// ADV-02: ingest a supplier ledger, verify each invoice's stamp, and report the
// input-VAT exposure plus a buyer-supplier graph. Persisted as an engagement
// when a client party is supplied.
router.post("/vat-risk/analyze", async (req, res): Promise<void> => {
  assertCan(req.principal, "engagement.write");
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(AnalyzeVatRiskBody, req.body);
  const rows = parsed.csv
    ? parseLedgerCsv(parsed.csv)
    : (parsed.rows ?? []);
  if (rows.length === 0) {
    res
      .status(400)
      .json({ error: "Provide a non-empty ledger via 'rows' or 'csv'" });
    return;
  }
  const pairs = rows
    .filter((r) => r.irn && r.csid)
    .map((r) => ({ irn: r.irn as string, csid: r.csid as string }));
  const validStamps = await verifyStampBatch(pairs);
  const report = analyzeLedger(rows, validStamps, parsed.buyerName);

  let engagementId: string | null = null;
  if (parsed.clientPartyId) {
    const [row] = await getDb()
      .insert(engagementsTable)
      .values({
        firmId,
        clientPartyId: parsed.clientPartyId,
        type: "vat_risk_check",
        status: "completed",
        title: `VAT-risk check (₦${report.totalVatAtRisk.toLocaleString("en-NG")} at risk)`,
        findings: {
          rowCount: report.rowCount,
          verifiedCount: report.verifiedCount,
          atRiskCount: report.atRiskCount,
          invalidCount: report.invalidCount,
          totalVatAmount: report.totalVatAmount,
          totalVatAtRisk: report.totalVatAtRisk,
        },
      })
      .returning();
    engagementId = row.id;
    await appendAudit({
      actorId: req.principal.userId,
      firmId,
      action: "vatrisk.analyze",
      entityType: "engagement",
      entityId: row.id,
      after: { totalVatAtRisk: report.totalVatAtRisk, atRiskCount: report.atRiskCount },
    });
  }

  res.json(AnalyzeVatRiskResponse.parse({ engagementId, ...report }));
});

export default router;
