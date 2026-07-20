import { Router, type IRouter } from "express";
import {
  AskClerkBody,
  AskClerkResponse,
  ExplainInvoiceFailureBody,
  ExplainInvoiceFailureResponse,
  DraftPaymentChaserBody,
  DraftPaymentChaserResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  clientPartyScope,
  tenantFirmId,
} from "../../modules/auth/rbac";
import { assertFirmClerkBudget } from "../../modules/clerk/budget";
import { askClerk } from "../../modules/clerk/ask";
import { explainInvoiceFailure } from "../../modules/clerk/explain";
import { draftPaymentChaser } from "../../modules/clerk/draft-chaser";
import { gatewayOrNull, getClerkGateway } from "../../modules/clerk/provider";

const router: IRouter = Router();

router.post("/clerk/ask", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.ask");
  const parsed = parseOrThrow(AskClerkBody, req.body);
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const gateway = await getClerkGateway();
  const row = await askClerk(parsed.question, req.principal.userId, gateway, {
    firmId: tenant,
    // Multi-turn (round 12): the asker's previous case in this thread; the
    // module re-verifies it belongs to this firm before any context is used.
    previousCaseId: parsed.previousCaseId ?? null,
    // Client posture (SEC-03): a client_user is offered only the client-safe
    // intent subset and every lookup is pinned to its own party by the
    // module — the party comes from the principal, never from model output.
    clientScoped: req.principal.role === "client_user",
    clientPartyId: clientPartyScope(req.principal),
  });
  res.json(AskClerkResponse.parse(row));
});

// Grounded failure explainer (expansion C): catalogue cause/fix for the
// invoice's latest failed attempt, Clerk-phrased when available. Falls back to
// the catalogue text itself when the kill switch or budget says no, so this
// never errors for AI-availability reasons. Gated on clerk.capture (not
// clerk.ask): the fix-and-retry flow belongs to the client whose invoice
// failed, and the module pins the invoice to the principal's firm AND client
// party (SEC-03) before a word is generated.
router.post("/clerk/explain-failure", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const parsed = parseOrThrow(ExplainInvoiceFailureBody, req.body);
  // Best-effort gateway (digest posture): a provider that cannot even load
  // answers with the catalogue text, never a 500.
  const gateway = await gatewayOrNull();
  const explanation = await explainInvoiceFailure(
    parsed.invoiceId,
    req.principal,
    gateway,
  );
  res.json(ExplainInvoiceFailureResponse.parse(explanation));
});

// Payment-chaser draft (round-9 idea #2): phrases one outstanding
// receivable's stored facts into a reminder the client copies and sends.
// Digest posture — the template always answers (no budget pre-check, no
// gateway requirement), so this can never 429 or 502 for a model reason.
// Same gate as the explainer: the client whose receivable it is may use it;
// the module enforces tenant + SEC-03 party scope.
router.post("/clerk/draft-chaser", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const parsed = parseOrThrow(DraftPaymentChaserBody, req.body);
  const gateway = await gatewayOrNull();
  const draft = await draftPaymentChaser(
    parsed.invoiceId,
    req.principal,
    gateway,
  );
  res.json(DraftPaymentChaserResponse.parse(draft));
});

export default router;
