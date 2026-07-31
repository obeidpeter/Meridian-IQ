import { Router, type IRouter } from "express";
import {
  DraftClaimWithClerkBody,
  DraftClaimWithClerkResponse,
  DraftCatalogueEntryWithClerkBody,
  DraftCatalogueEntryWithClerkResponse,
  AssistMatchProposalsBody,
  AssistMatchProposalsResponse,
  SuggestNarrationMatchesBody,
  SuggestNarrationMatchesResponse,
  DraftInvoiceWithClerkBody,
  DraftInvoiceWithClerkResponse,
  DraftStatementFormatWithClerkBody,
  DraftStatementFormatWithClerkResponse,
  DraftClientImportWithClerkBody,
  DraftClientImportWithClerkResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  requireFirmScope,
  tenantFirmId,
} from "../../modules/auth/rbac";
import { assertFirmClerkBudget } from "../../modules/clerk/budget";
import { draftFormatMappingWithClerk } from "../../modules/clerk/draft-format";
import { draftClientImportWithClerk } from "../../modules/clerk/draft-client-import";
import { draftCatalogueEntryWithClerk } from "../../modules/clerk/draft-catalogue";
import { draftClaimWithClerk } from "../../modules/clerk/draft-claim";
import { draftInvoiceWithClerk } from "../../modules/clerk/draft-invoice";
import { assistMatch } from "../../modules/clerk/reconcile-assist";
import { suggestNarrationMatches } from "../../modules/clerk/narration-match";
import { requireFlag } from "../../modules/flags/flags";
import { gatewayOrNull, getClerkGateway } from "../../modules/clerk/provider";

const router: IRouter = Router();

// Statement-format bootstrap (idea #9): Clerk proposes a column mapping from
// a pasted sample; the deterministic parser's validation run travels with the
// draft. Saving goes through POST /statement-formats, which re-validates.
router.post("/clerk/format-draft", async (req, res): Promise<void> => {
  assertCan(req.principal, "catalogue.write");
  const parsed = parseOrThrow(DraftStatementFormatWithClerkBody, req.body);
  const gateway = await getClerkGateway();
  const draft = await draftFormatMappingWithClerk(parsed.sampleCsv, gateway);
  res.json(DraftStatementFormatWithClerkResponse.parse(draft));
});

// Reconciliation match assist (idea #2): explains one statement line's
// pending candidates. Ranking and highlights are computed from the matcher's
// recorded features; Clerk only phrases the comparison and the deterministic
// template text answers whenever it can't — this never errors for
// AI-availability reasons.
router.post(
  "/clerk/reconciliation-assist",
  requireFlag("reconciliation"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "reconciliation.read");
    const parsed = parseOrThrow(AssistMatchProposalsBody, req.body);
    // Best-effort gateway: no provider configured still explains via the
    // template path (digest posture), unlike the fail-closed capture routes.
    const gateway = await gatewayOrNull();
    const result = await assistMatch(
      parsed.statementLineId,
      req.principal,
      gateway,
    );
    res.json(AssistMatchProposalsResponse.parse(result));
  },
);

// Narration match lane: Clerk reads a statement's middle-band narrations
// against each line's own proposal shortlist and records a pick or abstention
// per line (advisory only — acceptance stays the human decision path).
// Unlike its assist sibling above this is a REAL classification spend (up to
// NARRATION_SWEEP_CAP calls), so it is fail-closed: reconciliation.act (the
// decider's capability — suggestions exist to serve the accept decision, and
// client_user holds only reconciliation.read so it can never trigger spend),
// the firm budget gate BEFORE any provider touch, and getClerkGateway() so a
// broken provider or dark kill switch is an error, never a silent no-op.
// Runs OUTSIDE the request transaction (app.ts NO_CONTEXT_ROUTES, mirrored
// in the MODEL rate class): up to 20 sequential model calls must not pin a
// pooled connection under the 30s cap — the module commits each line's write
// in its own short firm-bound transaction (clerk scope.ts).
router.post(
  "/clerk/narration-suggestions",
  requireFlag("reconciliation"),
  async (req, res): Promise<void> => {
    assertCan(req.principal, "reconciliation.act");
    const parsed = parseOrThrow(SuggestNarrationMatchesBody, req.body);
    const firmId = requireFirmScope(req.principal);
    // Budget gate before the provider is touched (the statements-route
    // idiom): an exhausted firm gets a clean 429 without any model call.
    await assertFirmClerkBudget(firmId);
    const gateway = await getClerkGateway();
    const result = await suggestNarrationMatches(
      parsed.statementId,
      req.principal,
      gateway,
    );
    res.json(SuggestNarrationMatchesResponse.parse(result));
  },
);

// Natural-language invoice drafting (idea #7): one sentence in, a prefilled
// draft-form proposal out. Nothing is stored and no invoice is created — the
// client reviews the form and saves through the ordinary createDraft path.
router.post("/clerk/draft-invoice", async (req, res): Promise<void> => {
  assertCan(req.principal, "clerk.capture");
  const parsed = parseOrThrow(DraftInvoiceWithClerkBody, req.body);
  const tenant = tenantFirmId(req.principal);
  if (tenant) await assertFirmClerkBudget(tenant);
  const gateway = await getClerkGateway();
  const result = await draftInvoiceWithClerk(parsed, req.principal, gateway);
  res.json(DraftInvoiceWithClerkResponse.parse(result));
});

// Customer-list import drafting (exhaust idea #4): the statement-format seam
// applied to the client import. Firm-scoped and firm-funded (clients.import
// is a firm_admin capability); the draft never writes — the rows still walk
// the ordinary /clients/import validate/commit flow.
router.post("/clerk/client-import-draft", async (req, res): Promise<void> => {
  assertCan(req.principal, "clients.import");
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(DraftClientImportWithClerkBody, req.body);
  await assertFirmClerkBudget(firmId);
  const gateway = await getClerkGateway();
  const draft = await draftClientImportWithClerk(
    parsed.sampleCsv,
    firmId,
    gateway,
  );
  res.json(DraftClientImportWithClerkResponse.parse(draft));
});

// Claims drafting assistant (power C5): operator pastes a statutory excerpt,
// Clerk structures a DRAFT register entry. Maker-checker is untouched — the
// caller is the maker and can never approve the version it drafted.
router.post("/clerk/claims/draft", async (req, res): Promise<void> => {
  assertCan(req.principal, "claims.write");
  const parsed = parseOrThrow(DraftClaimWithClerkBody, req.body);
  const gateway = await getClerkGateway();
  const row = await draftClaimWithClerk(
    parsed.sourceText,
    req.principal.userId,
    gateway,
  );
  res.status(201).json(DraftClaimWithClerkResponse.parse(row));
});

// Catalogue drafting assistant (idea #3): Clerk proposes an error-catalogue
// entry grounded in the raw rail rejections observed for the code. The draft
// is RETURNED for the operator to edit — saving still goes through the
// ordinary catalogue.write routes, so the human disposes and the audit trail
// is theirs. Runs outside the request transaction (NO_CONTEXT_ROUTES) —
// though not every model-calling path does: the single-completion
// explainer/drafting routes (explain-failure, draft-chaser, reconcile
// assist, claims draft, both cover notes, reply drafts, narrative) stay
// inside the ordinary transaction.
router.post("/clerk/catalogue-draft", async (req, res): Promise<void> => {
  assertCan(req.principal, "catalogue.write");
  const parsed = parseOrThrow(DraftCatalogueEntryWithClerkBody, req.body);
  const gateway = await getClerkGateway();
  const draft = await draftCatalogueEntryWithClerk(parsed.code, gateway);
  res.json(DraftCatalogueEntryWithClerkResponse.parse(draft));
});

export default router;
