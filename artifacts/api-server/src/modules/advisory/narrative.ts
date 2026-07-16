import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { getDb, engagementsTable } from "@workspace/db";
import { DomainError } from "../errors";
import {
  assertClientPartyScope,
  assertSameTenant,
  tenantFirmId,
  type Principal,
} from "../auth/rbac";
import { assertFirmClerkBudget } from "../clerk/budget";
import { CLERK_FLAG_KEY, type ClerkGateway } from "../clerk/gateway";
import { fenceUntrusted } from "../clerk/prompts";
import { isFeatureEnabled } from "../flags/flags";

// Advisory narrative drafting (Clerk idea #10). Readiness assessments and
// VAT-risk checks compute their findings deterministically (ADV-01/02); the
// client-facing LETTER explaining them is still written by hand. This is the
// digest pattern applied to advisory: every fact in the narrative comes from
// the engagement's stored findings, the model only phrases them, and the
// deterministic template text answers whenever it can't (kill switch, budget,
// invalid output, no provider). The draft is RETURNED for the firm partner to
// edit and own — never stored, never sent.

const NARRATIVE_PROMPT_VERSION = "narrative.v1";

const NARRATIVE_SYSTEM = [
  "You draft the body of a client-facing letter for a Nigerian accounting firm, from advisory facts computed by the platform.",
  "Use ONLY the facts provided. Never add, change or estimate a number, score, rule, deadline or recommendation that is not in them.",
  "Tone: warm, professional, plain language for a small-business owner. 2-4 short paragraphs; a numbered list is fine for recommended steps.",
  "No letterhead, greeting, sign-off or placeholders — body text only; the firm adds those.",
  'Return JSON: {"narrative": string}.',
].join("\n");

const narrativeOutput = z.object({
  narrative: z.string().min(1).max(4000),
});

const NARRATIVE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: { narrative: { type: "string" } },
  required: ["narrative"],
};

export interface EngagementNarrative {
  engagementId: string;
  narrative: string;
  source: "clerk" | "template";
}

// findings is a Record<string, unknown> jsonb that the GENERIC engagement
// routes let firm staff write freely — the assessment/VAT-risk routes are the
// normal authors, but nothing guarantees it. So the shapes are VALIDATED here
// (malformed findings refuse rather than rendering NaN%), sizes are bounded,
// and the text fields (gap prompts, remediation actions) are treated as
// firm-authored data: fenced in the model prompt like every other non-platform
// string on a Clerk surface.
const readinessFindingsSchema = z.object({
  score: z.number().min(0).max(100),
  band: z.enum(["ready", "partial", "at_risk"]),
  gaps: z
    .array(
      z.object({
        section: z.string().max(200),
        prompt: z.string().max(400),
        severity: z.enum(["high", "medium", "low"]),
      }),
    )
    .max(60),
  remediation: z
    .array(
      z.object({
        action: z.string().max(400),
        rationale: z.string().max(400),
      }),
    )
    .max(60),
});
type ReadinessFindings = z.infer<typeof readinessFindingsSchema>;

const vatRiskFindingsSchema = z.object({
  rowCount: z.number().int().min(0),
  verifiedCount: z.number().int().min(0),
  atRiskCount: z.number().int().min(0),
  invalidCount: z.number().int().min(0),
  totalVatAmount: z.number().min(0),
  totalVatAtRisk: z.number().min(0),
});
type VatRiskFindings = z.infer<typeof vatRiskFindingsSchema>;

const BAND_PHRASES: Record<ReadinessFindings["band"], string> = {
  ready:
    "Your processes already cover the areas the e-invoicing mandate requires, and you are well placed for it.",
  partial:
    "Your e-invoicing readiness is developing — a small number of gaps need attention before the mandate applies to you.",
  at_risk:
    "Your current setup needs attention in several areas before you can meet the e-invoicing mandate confidently.",
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Deterministic letter bodies — also the grounding shown to the model. Gap
// prompts and remediation text are PLATFORM questionnaire template strings;
// firm-typed notes are deliberately excluded from both paths.
export function buildReadinessTemplate(f: ReadinessFindings): string {
  const paragraphs: string[] = [
    `Following our e-invoicing readiness assessment, your compliance posture scored ${f.score}%. ${BAND_PHRASES[f.band]}`,
  ];
  if (f.gaps.length === 0) {
    paragraphs.push(
      "We found no outstanding gaps in the areas the assessment covers.",
    );
  } else {
    const high = f.gaps.filter((g) => g.severity === "high").length;
    const lead = f.gaps
      .slice()
      .sort((a, b) => (a.severity === "high" ? -1 : b.severity === "high" ? 1 : 0))
      .slice(0, 3)
      .map((g) => g.prompt)
      .join("; ");
    paragraphs.push(
      `We identified ${plural(f.gaps.length, "gap")}${
        high > 0 ? ` (${high} high priority)` : ""
      }, including: ${lead}`,
    );
  }
  if (f.remediation.length > 0) {
    const steps = f.remediation
      .slice(0, 5)
      .map((r, i) => `${i + 1}. ${r.action} — ${r.rationale}`)
      .join("\n");
    paragraphs.push(`We recommend the following next steps:\n${steps}`);
  }
  paragraphs.push(
    "We will support you through each of these steps — please reach out with any questions.",
  );
  return paragraphs.join("\n\n");
}

export function buildVatRiskTemplate(f: VatRiskFindings): string {
  const paragraphs: string[] = [
    `We reviewed ${plural(f.rowCount, "ledger row")} for input-VAT exposure. ${f.verifiedCount} carried a verified e-invoice stamp and ${f.atRiskCount} did not${
      f.invalidCount > 0 ? `; ${f.invalidCount} could not be read` : ""
    }.`,
  ];
  if (f.atRiskCount > 0) {
    paragraphs.push(
      `Input VAT of NGN ${f.totalVatAtRisk} (of NGN ${f.totalVatAmount} reviewed in total) is at risk of disallowance until the underlying invoices carry valid stamps.`,
    );
    paragraphs.push(
      "We recommend contacting the suppliers behind the unstamped invoices to obtain compliant e-invoices before your next filing.",
    );
  } else {
    paragraphs.push(
      "All input VAT reviewed is protected by verified stamps — no action is needed on this ledger.",
    );
  }
  return paragraphs.join("\n\n");
}

// Draft the letter body for one completed advisory engagement. `gateway` may
// be null (no provider configured) — the template path always answers.
export async function draftEngagementNarrative(
  engagementId: string,
  principal: Principal,
  gateway: ClerkGateway | null,
): Promise<EngagementNarrative> {
  const [row] = await getDb()
    .select()
    .from(engagementsTable)
    .where(eq(engagementsTable.id, engagementId))
    .limit(1);
  if (!row || !row.findings) {
    throw new DomainError("NOT_FOUND", "Engagement not found", 404);
  }
  assertSameTenant(principal, row.firmId);
  assertClientPartyScope(principal, row.clientPartyId);

  let template: string;
  let facts: string;
  if (row.type === "readiness_assessment") {
    const parsed = readinessFindingsSchema.safeParse(row.findings);
    if (!parsed.success) {
      throw new DomainError(
        "FINDINGS_MALFORMED",
        "This engagement's findings do not have the assessment shape, so no letter can be grounded in them.",
        422,
      );
    }
    const findings = parsed.data;
    template = buildReadinessTemplate(findings);
    // Numbers stay outside the fence (platform-shaped by the schema above);
    // the gap/remediation STRINGS are firm-authorable and travel fenced.
    const textFacts = [
      `Gaps (${findings.gaps.length}): ${
        findings.gaps.map((g) => `[${g.severity}] ${g.prompt}`).join("; ") ||
        "(none)"
      }`,
      `Recommended steps: ${
        findings.remediation
          .slice(0, 5)
          .map((r, i) => `${i + 1}. ${r.action} (${r.rationale})`)
          .join("; ") || "(none)"
      }`,
    ].join("\n");
    facts = [
      `Assessment score: ${findings.score}% (band: ${findings.band})`,
      fenceUntrusted("assessment findings text", "FINDINGS", textFacts),
    ].join("\n");
  } else if (row.type === "vat_risk_check") {
    const parsed = vatRiskFindingsSchema.safeParse(row.findings);
    if (!parsed.success) {
      throw new DomainError(
        "FINDINGS_MALFORMED",
        "This engagement's findings do not have the VAT-risk shape, so no letter can be grounded in them.",
        422,
      );
    }
    const findings = parsed.data;
    template = buildVatRiskTemplate(findings);
    facts = [
      `Ledger rows reviewed: ${findings.rowCount}`,
      `Rows with a verified stamp: ${findings.verifiedCount}`,
      `Rows without a verified stamp (VAT at risk): ${findings.atRiskCount}`,
      `Unreadable rows: ${findings.invalidCount}`,
      `Total VAT reviewed: NGN ${findings.totalVatAmount}`,
      `VAT at risk of disallowance: NGN ${findings.totalVatAtRisk}`,
    ].join("\n");
  } else {
    throw new DomainError(
      "NARRATIVE_UNSUPPORTED",
      "Narratives are drafted for readiness assessments and VAT-risk checks only.",
      409,
    );
  }

  const fallback: EngagementNarrative = {
    engagementId,
    narrative: template,
    source: "template",
  };

  // Clerk phrasing is best-effort (digest posture): kill switch off, budget
  // spent or no provider → the grounded template text is the answer.
  if (!gateway) return fallback;
  if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return fallback;
  const tenant = tenantFirmId(principal);
  if (tenant) {
    try {
      await assertFirmClerkBudget(tenant);
    } catch {
      return fallback;
    }
  }

  const result = await gateway.infer<z.infer<typeof narrativeOutput>>({
    purpose: "draft_narrative",
    firmId: tenant,
    promptVersion: NARRATIVE_PROMPT_VERSION,
    system: NARRATIVE_SYSTEM,
    user: `Advisory facts computed by the platform:\n${facts}`,
    schemaName: "engagement_narrative",
    jsonSchema: NARRATIVE_JSON_SCHEMA,
    validator: narrativeOutput,
    inputForHash: `${engagementId}:${facts}`,
  });
  if (!result.ok) return fallback;
  return { engagementId, narrative: result.data.narrative, source: "clerk" };
}
