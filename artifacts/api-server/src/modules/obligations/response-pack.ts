import { z } from "zod/v4";
import {
  assertClientPartyScope,
  assertSameTenant,
  tenantFirmId,
  type Principal,
} from "../auth/rbac";
import { appendAudit } from "../audit/audit";
import { assertFirmClerkBudget } from "../clerk/budget";
import {
  CLERK_FLAG_KEY,
  inferPhrasing,
  type ClerkGateway,
} from "../clerk/gateway";
import { ensureGrounded } from "../clerk/grounding";
import {
  buildResponseLetterUser,
  buildTemplateResponseLetter,
  letterOutput,
  RESPONSE_LETTER_JSON_SCHEMA,
  RESPONSE_LETTER_PROMPT_VERSION,
  RESPONSE_LETTER_SYSTEM,
  RESPONSE_PHRASING,
  type ResponseLetterFacts,
} from "../clerk/response-letter";
import { isFeatureEnabled } from "../flags/flags";
import { DomainError } from "../errors";
import {
  computeCompliancePack,
  type CompliancePackFacts,
} from "../invoice/compliance-pack";
import {
  resolveVatPositionMonth,
  vatPositionMonths,
} from "../invoice/vat-position";
import { getObligation } from "./obligations";
import type { Obligation } from "@workspace/db";

// Response Desk (Task #207): the facts half of an obligation response — one
// obligation joined to its client's period figures (computeCompliancePack,
// the pack's own deterministic SQL, imported rather than mirrored so the
// response bundle and the monthly pack can never disagree about a month).
// Two consumers share this assembly: the response bundle PDF (zero model
// calls — response-pack-pdf.ts) and the letter draft below (the
// advisory-narrative posture: the model only phrases, ensureGrounded blocks
// invented numerals, and buildTemplateResponseLetter always answers).

// The period the figures cover. ONE home, both endpoints: an explicit month
// walks the VAT position's own live-month resolver (off-list → BAD_MONTH
// 400); omitted, the notice's issue month leads when it is on the live
// 12-month list (the figures an assessment argues about are usually that
// period's), else the current Lagos month.
export function resolveResponseMonth(
  obligation: Pick<Obligation, "issueDate">,
  raw?: string,
): string {
  if (raw) return resolveVatPositionMonth(raw);
  const months = vatPositionMonths();
  const issueMonth = obligation.issueDate
    ? `${obligation.issueDate.slice(0, 7)}-01`
    : null;
  return issueMonth && months.includes(issueMonth) ? issueMonth : months[0];
}

export interface ObligationResponseFacts {
  obligation: Obligation;
  pack: CompliancePackFacts;
  monthStart: string;
  monthLabel: string;
}

// Load one obligation under the routes' 404 non-disclosure dance (the
// GET /obligations/:id posture, verbatim): a foreign tenant's obligation and
// a sibling client's obligation are both indistinguishable from an id that
// does not exist. Only then is the month resolved and the pack computed.
export async function computeObligationResponseFacts(
  obligationId: string,
  principal: Principal,
  month?: string,
): Promise<ObligationResponseFacts> {
  const row = await getObligation(obligationId);
  const notFound = () =>
    new DomainError("NOT_FOUND", "Obligation not found", 404);
  if (!row) throw notFound();
  // 404 non-disclosure: CROSS_TENANT and CROSS_CLIENT both collapse to the
  // same not-found the missing id produces (the loadBillForScope posture).
  try {
    assertSameTenant(principal, row.firmId);
    assertClientPartyScope(principal, row.clientPartyId);
  } catch {
    throw notFound();
  }
  const monthStart = resolveResponseMonth(row, month);
  const pack = await computeCompliancePack(
    row.firmId,
    row.clientPartyId,
    monthStart,
  );
  return { obligation: row, pack, monthStart, monthLabel: pack.monthLabel };
}

// The period's figure lines, pre-rendered "Label: value" (the packNoteFacts
// shape) — ONE home shared by the letter facts (ResponseLetterFacts.packLines)
// and the bundle PDF's cover, so the letter and the paper it rides with can
// never state different figures for the same month.
export function responsePackLines(pack: CompliancePackFacts): string[] {
  const receivables = pack.receivables.groups.map(
    (g) =>
      `${g.currency} ${g.outstandingTotal} across ${g.invoiceCount} invoice(s)`,
  );
  const payables = pack.payables.groups.map(
    (g) => `${g.currency} ${g.total.amount} across ${g.total.count} bill(s)`,
  );
  return [
    `Documents issued in the month: ${pack.register.rows.length}${
      pack.register.truncated ? " or more (register truncated in the bundle)" : ""
    }`,
    `Outstanding receivables: ${receivables.length > 0 ? receivables.join("; ") : "none"}`,
    `Unpaid supplier bills: ${payables.length > 0 ? payables.join("; ") : "none"}`,
    `Output VAT: NGN ${pack.vat.outputVat}`,
    `Input VAT: NGN ${pack.vat.inputVat} (verified NGN ${pack.vat.inputVatVerified})`,
    `Net VAT position: NGN ${pack.vat.netVat} (defensible NGN ${pack.vat.defensibleNetVat})`,
    `Documents awaiting submission: ${pack.deadlines.unsubmittedReceivables}`,
    `Next VAT return due: ${pack.deadlines.nextVatReturnDue}`,
  ];
}

export interface ObligationResponseDraft {
  obligationId: string;
  letter: string;
  source: "clerk" | "template";
  monthStart: string;
  monthLabel: string;
}

// Draft the letter body for one obligation. The narrative.ts gate ladder
// exactly: no gateway → template; clerk_ai flag off → template; budget
// exhausted → template; inferPhrasing + ensureGrounded inside a try so
// ANYTHING failing past the checks still answers with the template, source
// tagged honestly — this surface never errors for AI-availability reasons.
// The route acquires the best-effort gateway (gatewayOrNull — the codebase
// convention; the route rides the MODEL rate class); tests inject
// fakeGateway or null.
export async function draftObligationResponse(
  obligationId: string,
  principal: Principal,
  gateway: ClerkGateway | null,
  month?: string,
): Promise<ObligationResponseDraft> {
  const { obligation, pack, monthStart, monthLabel } =
    await computeObligationResponseFacts(obligationId, principal, month);

  // The letter's whole world: the obligation row verbatim (the fenced NOTICE
  // block — outsider-influenced free text) plus the period's figure lines.
  const facts: ResponseLetterFacts = {
    obligation: {
      authority: obligation.authority,
      noticeType: obligation.noticeType,
      reference: obligation.reference,
      taxType: obligation.taxType,
      period: obligation.period,
      amount: obligation.amount,
      currency: obligation.currency,
      issueDate: obligation.issueDate,
      responseDueDate: obligation.responseDueDate,
      notes: obligation.notes,
    },
    clientName: pack.clientName,
    firmName: pack.firmName,
    monthLabel,
    packLines: responsePackLines(pack),
  };

  const fallback: ObligationResponseDraft = {
    obligationId,
    letter: buildTemplateResponseLetter(facts),
    source: "template",
    monthStart,
    monthLabel,
  };
  const draft = await phraseResponseLetter(
    obligationId,
    principal,
    gateway,
    facts,
    fallback,
  );
  // Pointer-only audit (SEC-12): which obligation, which month, which source
  // answered — never the letter text or any notice content.
  await appendAudit({
    actorId: principal.userId,
    firmId: obligation.firmId,
    action: "obligation.response_draft",
    entityType: "obligation",
    entityId: obligation.id,
    after: { month: monthStart, source: draft.source },
  });
  return draft;
}

// The Clerk half, folded to the fallback on every failure (digest posture).
async function phraseResponseLetter(
  obligationId: string,
  principal: Principal,
  gateway: ClerkGateway | null,
  facts: ResponseLetterFacts,
  fallback: ObligationResponseDraft,
): Promise<ObligationResponseDraft> {
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
  const user = buildResponseLetterUser(facts);
  // One phrasing call under the digest posture: inferPhrasing re-checks the
  // kill switch and folds every typed gateway failure to null (the
  // narrative.ts TOCTOU note); the outer try keeps the stronger guarantee
  // that even a grounding-check crash still answers with the template.
  try {
    const data = await inferPhrasing<z.infer<typeof letterOutput>>(gateway, {
      purpose: "draft_response_letter",
      firmId: tenant,
      promptVersion: RESPONSE_LETTER_PROMPT_VERSION,
      system: RESPONSE_LETTER_SYSTEM,
      user,
      schemaName: RESPONSE_PHRASING.schemaName,
      jsonSchema: RESPONSE_LETTER_JSON_SCHEMA,
      validator: letterOutput,
      inputForHash: `${obligationId}:${user}`,
    });
    if (!data) return fallback;
    // Number grounding: a numeral the facts never stated → template answers
    // (grounding.ts). The allowed source is the exact composed user prompt.
    if (!(await ensureGrounded("response_letter", tenant, data.letter, user))) {
      return fallback;
    }
    return { ...fallback, letter: data.letter, source: "clerk" };
  } catch {
    return fallback;
  }
}
