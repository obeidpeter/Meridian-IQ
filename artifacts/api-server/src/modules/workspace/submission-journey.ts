import { and, eq } from "drizzle-orm";
import { getDb, invoicesTable, stampRecordsTable } from "@workspace/db";
import { can, clientPartyScope, type Principal } from "../auth/rbac";
import { isPurposePermitted } from "../consent/consent";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";
import { assertSubmitApproved } from "../invoice/approvals";
import { railTransportSummary } from "../rails/adapter";
import type { SetupStep } from "./setup-step";

type JourneyInvoice = {
  id: string;
  firmId: string;
  supplierPartyId: string;
  status: string;
};

export interface SubmissionProof {
  status?: string;
  consent: boolean;
  approval: boolean;
  canSubmit: boolean;
  enabled: boolean;
  liveService: boolean;
  stamp?: {
    environment: string;
    provider: string;
    irn: string;
    csid: string;
    signedArtifactRef: string;
  };
}

const submittedStates = new Set([
  "submitted",
  "stamped",
  "confirmed",
  "settled",
  "credited",
]);
const acceptedStates = new Set(["stamped", "confirmed", "settled", "credited"]);

function hasLiveAcceptance(proof: SubmissionProof): boolean {
  const accepted = acceptedStates.has(proof.status ?? "");
  return Boolean(
    accepted &&
    proof.stamp?.environment === "live" &&
    proof.stamp.provider.trim().toLowerCase() !== "simulator" &&
    proof.stamp.provider.trim() &&
    proof.stamp.irn.trim() &&
    proof.stamp.csid.trim() &&
    proof.stamp.signedArtifactRef.trim(),
  );
}

function submissionBlockers(proof: SubmissionProof, queued: boolean): string[] {
  return [
    !proof.status && "Save an invoice first.",
    proof.status &&
      !queued &&
      proof.status !== "validated" &&
      "The invoice needs checking. Open it to fix validation errors or review a failed submission.",
    !proof.enabled &&
      "The Valo team must enable invoice submission for this firm.",
    !proof.canSubmit &&
      "An authorised member of your firm must submit this invoice.",
    !proof.consent &&
      "The business must grant submission consent. It can still keep and edit drafts without granting consent.",
    !proof.approval &&
      "Ask a different authorised reviewer to approve the current invoice details.",
    !proof.liveService &&
      "The Valo team must configure the live submission service. Test processing is not live acceptance.",
  ].filter((value): value is string => Boolean(value));
}

export function submissionJourneySteps(
  proof: SubmissionProof,
  href: string,
  consentHref: string,
): SetupStep[] {
  const queued = submittedStates.has(proof.status ?? "");
  const liveAcceptance = hasLiveAcceptance(proof);
  const testStamp = proof.stamp && !liveAcceptance;
  const blockers = submissionBlockers(proof, queued);
  return [
    {
      id: "invoice_consent",
      label: "Review submission consent",
      description: proof.consent
        ? "The business currently permits compliance submission. This is not tax-authority approval."
        : "The business decides whether to permit submission. Refusing consent does not prevent preparing drafts.",
      complete: proof.consent,
      href: consentHref,
    },
    {
      id: "invoice_approval",
      label: "Check internal approval",
      description: proof.approval
        ? "The current approval requirement is satisfied for your account, or the firm does not require a second reviewer. This is not official acceptance."
        : "Ask a different authorised reviewer to approve these invoice details. Editing the invoice requires a fresh review.",
      complete: proof.approval,
      href,
    },
    {
      id: "invoice_service",
      label: "Check the live submission service",
      description: proof.liveService
        ? "A production submission service is configured. This does not prove a successful connection or submission."
        : "Only test processing or an unconfigured service is available. Contact the Valo team before attempting a live submission.",
      complete: proof.liveService,
      href,
      ...(!proof.liveService
        ? {
            blockedReason:
              "The Valo team must configure a live submission service. You can continue preparing and validating drafts.",
          }
        : {}),
    },
    {
      id: "invoice_submission",
      label: queued
        ? "Submission recorded"
        : "Submit the invoice for processing",
      description: queued
        ? "The invoice has entered processing. This does not mean the tax authority has accepted it. Check the recorded response below."
        : "Open the invoice to review and confirm submission. The server checks permission, consent, approval and invoice state again when you submit.",
      complete: queued,
      href,
      ...(!queued && blockers.length
        ? { blockedReason: blockers.join(" ") }
        : {}),
    },
    {
      id: "invoice_acknowledgement",
      label: "Check the live acceptance record",
      description: liveAcceptance
        ? "A production stamp and its reference are recorded for this invoice. Review the response and keep the supporting records. This does not confirm payment."
        : testStamp
          ? "Only a test or incomplete stamp is recorded. It is not a live tax-authority acceptance. Ask your firm to review the record before continuing."
          : queued
            ? "Processing has started, but no complete production stamp is recorded yet. Check the invoice for a response or an error; do not submit it again while processing."
            : "This step completes only when a production stamp is recorded for this invoice, not when a draft is saved or a submission is queued.",
      complete: liveAcceptance,
      href,
    },
  ];
}

// Advisory reads only. Submission still uses the locked, authoritative write
// path; this snapshot must never be accepted as permission to skip its guards.
export async function firstSubmissionSetup(
  principal: Principal,
  invoice: JourneyInvoice | undefined,
  href: string,
): Promise<SetupStep[]> {
  if (!invoice) return [];
  let approval = true;
  try {
    await assertSubmitApproved(invoice, principal.userId);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "APPROVAL_REQUIRED")
      throw error;
    approval = false;
  }
  const consent = await isPurposePermitted(
    invoice.supplierPartyId,
    "compliance_submission",
  );
  const enabled = await isFeatureEnabled("invoice_lifecycle", invoice.firmId);
  const [stamp] = await getDb()
    .select({
      environment: stampRecordsTable.environment,
      provider: stampRecordsTable.provider,
      irn: stampRecordsTable.irn,
      csid: stampRecordsTable.csid,
      signedArtifactRef: stampRecordsTable.signedArtifactRef,
    })
    .from(stampRecordsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, stampRecordsTable.invoiceId))
    .where(
      and(
        eq(stampRecordsTable.invoiceId, invoice.id),
        eq(invoicesTable.firmId, invoice.firmId),
        eq(invoicesTable.supplierPartyId, invoice.supplierPartyId),
      ),
    )
    .limit(1);
  const service = railTransportSummary();
  return submissionJourneySteps(
    {
      status: invoice.status,
      consent,
      approval,
      canSubmit: can(principal, "invoice.submit"),
      enabled,
      liveService:
        service.environment === "live" &&
        service.transport !== "simulator" &&
        Object.values(service.rails).some((rail) => rail.configured),
      stamp,
    },
    href,
    clientPartyScope(principal)
      ? "/consent"
      : `/clients/${invoice.supplierPartyId}?view=setup`,
  );
}
