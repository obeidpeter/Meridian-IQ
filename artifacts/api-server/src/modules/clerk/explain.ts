import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod/v4";
import {
  getDb,
  errorCatalogueTable,
  invoicesTable,
  submissionAttemptsTable,
} from "@workspace/db";
import { DomainError } from "../errors";
import {
  assertClientPartyScope,
  assertSameTenant,
  tenantFirmId,
  type Principal,
} from "../auth/rbac";
import { CLERK_FLAG_KEY, type ClerkGateway } from "./gateway";
import { isFeatureEnabled } from "../flags/flags";
import { assertFirmClerkBudget } from "./budget";

// Contextual Clerk (expansion C): "what's wrong with this invoice?". The
// answer is ALWAYS grounded in the error catalogue — the deterministic
// cause/fix entry for the invoice's latest failed submission attempt. When
// Clerk is available (flag on, budget left) the model only REPHRASES that
// entry into plain language; if the call fails, is discarded, or Clerk is
// off, the catalogue text itself is returned. Either way the content never
// leaves the catalogue's grounding, so this endpoint is safe for clients.

const EXPLAIN_PROMPT_VERSION = "explain-v1";
const EXPLAIN_SYSTEM = [
  "You rewrite a tax-authority error-catalogue entry for a Nigerian small-business owner.",
  "Use ONLY the cause and fix text provided; do not add rules, rates, deadlines or remediation steps that are not in it.",
  "Write 1-3 plain, reassuring sentences explaining what went wrong, then 1-3 concrete next steps.",
  'Return JSON: {"explanation": string, "nextSteps": string[]}.',
].join("\n");

const explainOutput = z.object({
  explanation: z.string().min(1),
  nextSteps: z.array(z.string().min(1)).min(1).max(3),
});

const explainJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["explanation", "nextSteps"],
  properties: {
    explanation: { type: "string" },
    nextSteps: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
  },
};

export interface FailureExplanation {
  errorCode: string;
  explanation: string;
  nextSteps: string[];
  source: "clerk" | "catalogue";
}

export async function explainInvoiceFailure(
  invoiceId: string,
  principal: Principal,
  // Null when no provider is available (routes pass gatewayOrNull()): the
  // grounded catalogue text answers, per the digest posture above.
  gateway: ClerkGateway | null,
): Promise<FailureExplanation> {
  const [invoice] = await getDb()
    .select({
      id: invoicesTable.id,
      firmId: invoicesTable.firmId,
      supplierPartyId: invoicesTable.supplierPartyId,
      invoiceNumber: invoicesTable.invoiceNumber,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  // Same tenancy posture as GET /invoices/:id — firm match plus the SEC-03
  // client narrowing to the supplier party.
  assertSameTenant(principal, invoice.firmId);
  assertClientPartyScope(principal, invoice.supplierPartyId);

  const [attempt] = await getDb()
    .select({ errorCode: submissionAttemptsTable.errorCode })
    .from(submissionAttemptsTable)
    .where(
      and(
        eq(submissionAttemptsTable.invoiceId, invoiceId),
        isNotNull(submissionAttemptsTable.errorCode),
      ),
    )
    .orderBy(desc(submissionAttemptsTable.createdAt))
    .limit(1);
  if (!attempt?.errorCode) {
    throw new DomainError(
      "NO_FAILURE",
      "This invoice has no failed submission to explain",
      404,
    );
  }

  const [entry] = await getDb()
    .select()
    .from(errorCatalogueTable)
    .where(eq(errorCatalogueTable.code, attempt.errorCode))
    .limit(1);
  // Unmapped codes exist (INT-02 opens an operator case for them); the honest
  // fallback tells the client the desk is on it rather than inventing a fix.
  const cause =
    entry?.cause ?? "The tax authority returned an error we have not mapped yet.";
  const fix =
    entry?.fix ??
    "Our compliance desk reviews unmapped errors — no action is needed from you right now.";
  const catalogueFallback: FailureExplanation = {
    errorCode: attempt.errorCode,
    explanation: cause,
    nextSteps: [fix],
    source: "catalogue",
  };

  // Clerk phrasing is best-effort: no provider, kill switch off or budget
  // spent → the grounded catalogue text is the answer, not an error.
  if (!gateway || !(await isFeatureEnabled(CLERK_FLAG_KEY))) {
    return catalogueFallback;
  }
  const tenant = tenantFirmId(principal);
  if (tenant) {
    try {
      await assertFirmClerkBudget(tenant);
    } catch {
      return catalogueFallback;
    }
  }

  const user = [
    `Invoice number: ${invoice.invoiceNumber}`,
    `Error code: ${attempt.errorCode}`,
    `Catalogue cause: ${cause}`,
    `Catalogue fix: ${fix}`,
  ].join("\n");
  const result = await gateway.infer<z.infer<typeof explainOutput>>({
    purpose: "explain_failure",
    caseId: null,
    firmId: tenant,
    promptVersion: EXPLAIN_PROMPT_VERSION,
    system: EXPLAIN_SYSTEM,
    user,
    schemaName: "failure_explanation",
    jsonSchema: explainJsonSchema,
    validator: explainOutput,
    inputForHash: `${invoiceId}:${attempt.errorCode}`,
  });
  if (!result.ok) return catalogueFallback;
  return {
    errorCode: attempt.errorCode,
    explanation: result.data.explanation,
    nextSteps: result.data.nextSteps,
    source: "clerk",
  };
}
