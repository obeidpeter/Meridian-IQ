// Readiness-assessment kit (ADV-01). A structured yes/no questionnaire over the
// dimensions that decide whether a business can survive Nigerian e-invoicing
// pre-clearance (MBS). Completing an assessment produces a weighted score, a
// gap report and a prioritised remediation plan; the route persists the result
// as Engagement findings so it is queryable in the spine.

export interface AssessmentQuestion {
  id: string;
  prompt: string;
  helpText: string;
  weight: number; // 3 = blocking, 2 = material, 1 = hygiene
  remediation: string; // internal: the action if this control is absent
}

interface Section {
  id: string;
  title: string;
  questions: AssessmentQuestion[];
}

// Version bumped whenever the question set or scoring changes so persisted
// findings remain interpretable against the template that produced them.
export const QUESTIONNAIRE_VERSION = 1;

const SECTIONS: Section[] = [
  {
    id: "identifiers",
    title: "Registration & identifiers",
    questions: [
      {
        id: "tin_valid",
        prompt: "Does the business hold a valid Tax Identification Number (TIN)?",
        helpText:
          "A validated TIN is mandatory on every invoice submitted to the MBS platform.",
        weight: 3,
        remediation:
          "Register for or validate the business TIN with the FIRS before any submission is attempted.",
      },
      {
        id: "cac_number",
        prompt: "Is the CAC company registration number on file?",
        helpText: "The CAC number identifies the legal person on the party record.",
        weight: 2,
        remediation:
          "Capture and verify the CAC registration number and attach it to the party record.",
      },
      {
        id: "vat_registered",
        prompt: "Is the business registered for VAT?",
        helpText:
          "VAT registration governs output-VAT reporting and input-VAT recovery.",
        weight: 2,
        remediation:
          "Complete VAT registration with the FIRS and record the effective date.",
      },
      {
        id: "mbs_onboarded",
        prompt:
          "Has the business been onboarded to the MBS / access-point provider?",
        helpText:
          "Pre-clearance requires an active channel to an accredited access-point provider.",
        weight: 3,
        remediation:
          "Complete access-point onboarding so invoices can be transmitted for stamping.",
      },
    ],
  },
  {
    id: "invoice_data",
    title: "Invoice data readiness",
    questions: [
      {
        id: "mandatory_fields",
        prompt:
          "Are all mandatory invoice fields (BIS Billing 3.0) captured for every sale?",
        helpText:
          "Missing mandatory fields are the most common cause of MBS rejection.",
        weight: 3,
        remediation:
          "Map every mandatory BIS Billing 3.0 field into the invoicing process and validate before submission.",
      },
      {
        id: "tax_codes",
        prompt: "Are correct VAT/tax category codes applied per line item?",
        helpText: "Tax category codes drive the VAT calculation and its validation.",
        weight: 2,
        remediation:
          "Establish a tax-code mapping for each product/service line and apply it consistently.",
      },
      {
        id: "counterparty_tins",
        prompt: "Are buyer TINs captured for B2B and B2G transactions?",
        helpText: "B2B/B2G invoices must identify the buyer by TIN.",
        weight: 2,
        remediation:
          "Collect and validate buyer TINs during onboarding of each business customer.",
      },
    ],
  },
  {
    id: "systems",
    title: "Systems & integration",
    questions: [
      {
        id: "accounting_export",
        prompt:
          "Can the accounting/ERP system export invoices in a structured format (CSV/Excel/API)?",
        helpText: "A structured export is required to map to the canonical model.",
        weight: 2,
        remediation:
          "Enable a structured export from the accounting system or adopt the published import template.",
      },
      {
        id: "connectivity",
        prompt:
          "Is there reliable internet connectivity at the point of invoicing?",
        helpText:
          "Submission and validation require connectivity; draft capture can be offline.",
        weight: 1,
        remediation:
          "Provision a connectivity fallback (mobile data/secondary line) for invoicing hours.",
      },
    ],
  },
  {
    id: "controls",
    title: "Process & controls",
    questions: [
      {
        id: "owner_assigned",
        prompt: "Is a named person responsible for e-invoicing compliance?",
        helpText: "Clear ownership prevents missed deadlines and unresolved failures.",
        weight: 1,
        remediation:
          "Assign a named compliance owner and document the escalation path.",
      },
      {
        id: "failure_handling",
        prompt:
          "Is there a process to resolve and re-submit rejected invoices promptly?",
        helpText: "Unresolved rejections accrue penalties and block input-VAT recovery.",
        weight: 2,
        remediation:
          "Adopt the guided failure-resolution workflow and the error catalogue for rejections.",
      },
      {
        id: "retention",
        prompt:
          "Are stamped invoices and records retained for the required period?",
        helpText: "A minimum 24-month retention applies; the MeridianIQ standard is 7 years.",
        weight: 1,
        remediation:
          "Enable long-term retention of stamped artifacts on Nigeria-resident storage.",
      },
    ],
  },
];

const ALL_QUESTIONS: AssessmentQuestion[] = SECTIONS.flatMap((s) => s.questions);
const TOTAL_WEIGHT = ALL_QUESTIONS.reduce((sum, q) => sum + q.weight, 0);

function severityForWeight(weight: number): "high" | "medium" | "low" {
  if (weight >= 3) return "high";
  if (weight === 2) return "medium";
  return "low";
}

const SEVERITY_RANK: Record<"high" | "medium" | "low", number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface PublicQuestion {
  id: string;
  prompt: string;
  helpText: string;
  weight: number;
}

export interface QuestionnaireTemplateShape {
  version: number;
  sections: {
    id: string;
    title: string;
    questions: PublicQuestion[];
  }[];
}

// Public template (no internal remediation text) for the client-facing kit.
export function getQuestionnaireTemplate(): QuestionnaireTemplateShape {
  return {
    version: QUESTIONNAIRE_VERSION,
    sections: SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      questions: s.questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        helpText: q.helpText,
        weight: q.weight,
      })),
    })),
  };
}

export interface AnswerInput {
  questionId: string;
  answer: boolean;
  note?: string;
}

export interface GapItem {
  questionId: string;
  section: string;
  prompt: string;
  severity: "high" | "medium" | "low";
  note?: string;
}

export interface RemediationItem {
  priority: number;
  action: string;
  rationale: string;
  relatedQuestionId: string;
}

export interface AssessmentComputation {
  version: number;
  score: number;
  band: "ready" | "partial" | "at_risk";
  gaps: GapItem[];
  remediation: RemediationItem[];
}

// Compute the gap report and remediation plan from questionnaire answers. A
// question that is unanswered is treated as a gap (control not in place), so a
// partial submission can never inflate the readiness score.
export function computeAssessment(answers: AnswerInput[]): AssessmentComputation {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const sectionOf = new Map<string, string>();
  for (const s of SECTIONS) {
    for (const q of s.questions) sectionOf.set(q.id, s.title);
  }

  let earned = 0;
  const gaps: GapItem[] = [];
  for (const q of ALL_QUESTIONS) {
    const a = byId.get(q.id);
    if (a?.answer === true) {
      earned += q.weight;
    } else {
      gaps.push({
        questionId: q.id,
        section: sectionOf.get(q.id) ?? "",
        prompt: q.prompt,
        severity: severityForWeight(q.weight),
        note: a?.note,
      });
    }
  }

  const score = TOTAL_WEIGHT === 0 ? 100 : Math.round((earned / TOTAL_WEIGHT) * 100);
  const band: "ready" | "partial" | "at_risk" =
    score >= 80 ? "ready" : score >= 50 ? "partial" : "at_risk";

  const remediationSource = [...gaps].sort((x, y) => {
    const bySeverity = SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity];
    if (bySeverity !== 0) return bySeverity;
    return x.questionId.localeCompare(y.questionId);
  });
  const remediation: RemediationItem[] = remediationSource.map((gap, i) => {
    const q = ALL_QUESTIONS.find((qq) => qq.id === gap.questionId)!;
    return {
      priority: i + 1,
      action: q.remediation,
      rationale: `${gap.section}: ${gap.prompt}`,
      relatedQuestionId: gap.questionId,
    };
  });

  return { version: QUESTIONNAIRE_VERSION, score, band, gaps, remediation };
}
