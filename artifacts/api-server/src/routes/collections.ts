import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  collectionAccountsTable,
  type CollectionAccountRow,
} from "@workspace/db";
import {
  ListCollectionAccountsQueryParams,
  ListCollectionAccountsResponse,
  CreateCollectionAccountBody,
  CreateCollectionAccountResponse,
  DeactivateCollectionAccountParams,
  DeactivateCollectionAccountResponse,
  GetUnmatchedCollectionsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { opTokenAllows, presentedOpToken } from "../lib/op-token";
import {
  assertCan,
  assertPartyAccess,
  assertSameTenant,
  requireFirmScope,
} from "../modules/auth/rbac";
import { DomainError } from "../modules/errors";
import { isPositiveMoney } from "../lib/money";
import { listUnmatchedCollections } from "../modules/collections/unmatched";
import {
  createCollectionAccount,
  listCollectionAccounts,
  deactivateCollectionAccount,
  recordInboundCollection,
} from "../modules/collections/service";

// Collection accounts (compliance round): virtual account references per
// client whose inbound payments auto-observe settlements. The contract routes
// carry the statement-connections gates EXACTLY (statement.write + firm
// scope): provisioning a payment rail for a client is firm-STAFF plumbing —
// the role matrix grants statement.write to firm_admin/firm_staff and
// deliberately NOT to client_user (SEC-03) nor the cross-tenant
// operator/auditor roles. The inbound webhook below is a machine rail
// deliberately OFF the OpenAPI contract, the inbound-rail posture exactly.

const router: IRouter = Router();

// The contract serializes createdAt as a plain timestamp string, so the view
// serializes dates explicitly instead of returning raw rows (and firmId /
// createdByUserId never leave the server — the contract has no such fields).
function accountView(row: CollectionAccountRow): Record<string, unknown> {
  return {
    id: row.id,
    clientPartyId: row.clientPartyId,
    provider: row.provider,
    accountReference: row.accountReference,
    label: row.label,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

// Unmatched inbound payments (round-17 idea #3): the webhook's own
// pointer-only `collections.unmatched` audit events read back per account —
// money arrived on a live account and bound to no invoice. Same firm gate as
// the accounts list; nothing here carries amounts (they were never recorded).
router.get(
  "/collection-accounts/unmatched",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "statement.write");
    const firmId = requireFirmScope(req.principal);
    const report = await listUnmatchedCollections(firmId);
    res.json(GetUnmatchedCollectionsResponse.parse(report));
  },
);

router.get("/collection-accounts", async (req, res): Promise<void> => {
  assertCan(req.principal, "statement.write");
  requireFirmScope(req.principal);
  const query = parseOrThrow(ListCollectionAccountsQueryParams, req.query);
  // The queried client must be one this firm engages (cross-tenant probe of
  // another firm's party id is a 403, not an empty list).
  await assertPartyAccess(req.principal, query.clientPartyId);
  const rows = await listCollectionAccounts(query.clientPartyId);
  res.json(ListCollectionAccountsResponse.parse(rows.map(accountView)));
});

router.post("/collection-accounts", async (req, res): Promise<void> => {
  assertCan(req.principal, "statement.write");
  requireFirmScope(req.principal);
  const body = parseOrThrow(CreateCollectionAccountBody, req.body);
  // Party access + durable reservation + provider provisioning + activation
  // + pointer-only audit live in the service. A broken relay leaves only the
  // hidden reservation needed for an idempotent retry; it never exposes an
  // active account that the provider did not create.
  const row = await createCollectionAccount(
    req.principal,
    {
      clientPartyId: body.clientPartyId,
      label: body.label ?? null,
    },
    req.abortSignal,
  );
  res.status(201).json(CreateCollectionAccountResponse.parse(accountView(row)));
});

router.post(
  "/collection-accounts/:id/deactivate",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "statement.write");
    const params = parseOrThrow(DeactivateCollectionAccountParams, req.params);
    const [account] = await getDb()
      .select()
      .from(collectionAccountsTable)
      .where(eq(collectionAccountsTable.id, params.id))
      .limit(1);
    if (!account) {
      throw new DomainError("NOT_FOUND", "Collection account not found", 404);
    }
    assertSameTenant(req.principal, account.firmId);
    // Idempotent CAS flip in the service: a replay returns the already
    // inactive row unchanged.
    const row = await deactivateCollectionAccount(params.id);
    res.json(DeactivateCollectionAccountResponse.parse(accountView(row!)));
  },
);

// Inbound collection webhook (machine rail). The provider (or its relay)
// POSTs each payment observed on a virtual account reference here.
// Deliberately NOT in the OpenAPI contract: no human client ever calls this,
// and the generated SDKs must not grow a way to mark invoices settled.
//
// Gate posture — FAIL-CLOSED, the inbound-rail stance (routes/inbound.ts),
// the opposite of METRICS_TOKEN's open-when-unset default: this endpoint
// SETTLES money state on the word of an unauthenticated caller, so with no
// COLLECTION_WEBHOOK_TOKEN configured the rail must not exist at all — every
// request 404s exactly like an unknown route. Setting the env var lights the
// rail; the shared secret then IS the credential (constant-time compare via
// lib/op-token.ts), presented only in the x-op-token header so credentials
// never enter URLs, browser history or access logs.
//
// Local (non-generated) schema: this webhook is off-contract by design.
const InboundCollectionBody = z.object({
  accountReference: z.string().min(1).max(256),
  amount: z.string().refine(isPositiveMoney),
  invoiceNumber: z.string().min(1).max(256),
  reference: z.string().min(1).max(200),
  paidAt: z.string().datetime().optional(),
});

router.post("/collections/inbound", async (req, res): Promise<void> => {
  const expected = process.env.COLLECTION_WEBHOOK_TOKEN;
  if (!expected) {
    // Rail is dark: indistinguishable from a route that does not exist.
    res.status(404).json({ error: "Not found" });
    return;
  }
  const presented = presentedOpToken(req);
  if (!presented || !opTokenAllows(expected, presented)) {
    res
      .status(401)
      .json({ error: "Invalid or missing collection webhook token" });
    return;
  }
  const parsed = InboundCollectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid inbound collection payload" });
    return;
  }

  // Record, then 202 EITHER WAY: {applied:false} means an unknown or
  // deactivated reference — or an unmatchable invoice number — which must
  // all look identical so a caller holding the shared secret still cannot
  // probe which references are live. The write is durable before the 202
  // goes out (the module commits its own bypass transaction — this route
  // skips the buffered request transaction, see app.ts).
  await recordInboundCollection(parsed.data);
  res.status(202).json({ received: true });
});

export default router;
