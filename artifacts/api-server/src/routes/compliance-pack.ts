import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { getDb, alertPreferencesTable, firmsTable } from "@workspace/db";
import {
  GetCompliancePackQueryParams,
  NotifyCompliancePackBody,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { resolveClientAnalyticsScope } from "../lib/client-scope";
import {
  assertCan,
  assertPartyAccess,
  requireFirmScope,
} from "../modules/auth/rbac";
import { computeCompliancePack } from "../modules/invoice/compliance-pack";
import { resolveVatPositionMonth } from "../modules/invoice/vat-position";
import { renderCompliancePackPdf } from "../modules/invoice/pack-pdf";
import { sendPdfAttachment, themeWithBrandFallback } from "../modules/invoice/pdf";
import { draftPackCoverNote } from "../modules/clerk/pack-note";
import { gatewayOrNull } from "../modules/clerk/provider";
import { fanOutAlert } from "../modules/messaging/fan-out";
import { pointerEntityRef } from "../modules/messaging/recipient-ref";
import { appendAudit } from "../modules/audit/audit";

// Monthly client compliance pack (contract 0.45.0): one client's Lagos month
// as a branded PDF — cover note, document register, receivables, payables,
// VAT position and deadlines — plus the consent-gated "your pack is ready"
// fan-out. Facts are deterministic SQL (modules/invoice/compliance-pack.ts);
// the only model touch is the cover-note phrasing, digest posture end to end.
// NOTE: this router is NOT self-registering — it must be mounted in
// routes/index.ts (the orchestrator wires that up).

const router: IRouter = Router();

// The live-month discipline — resolveVatPositionMonth (modules/invoice/
// vat-position.ts), the VAT position's own resolver, imported rather than
// mirrored: the requested month, or the CURRENT Lagos month when omitted,
// must be on the position's own 12-month option list (the pack embeds the
// position, so the two surfaces accept exactly the same months by
// construction). The deliberately different CLOSED-month resolver is
// resolveClosedPeriod (routes/invoices/packs.ts) — keep them separate.

router.get("/compliance-pack", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(GetCompliancePackQueryParams, req.query);
  // SEC-03: a client_user is pinned to its own party (a sibling id in the
  // query is ignored in favour of the pin); a firm principal names the
  // client — the bills/analytics routes' exact scope resolution.
  const { firmId, clientPartyId } = resolveClientAnalyticsScope(
    req.principal,
    query.clientPartyId,
  );
  const month = resolveVatPositionMonth(query.month);
  const facts = await computeCompliancePack(firmId, clientPartyId, month);
  // Digest posture end to end — kill switch, missing provider, exhausted
  // budget or invalid output all answer with the deterministic template
  // (never an error), so there is no route budget pre-check: the module
  // treats the gateway backstop's typed budget-exhausted failure as one more
  // reason to answer with the template (the routes/invoices/packs.ts vat-pack
  // cover-note posture).
  const gateway = await gatewayOrNull();
  const note = await draftPackCoverNote(
    firmId,
    clientPartyId,
    month,
    gateway,
    facts,
  );
  const [firm] = await getDb()
    .select({ name: firmsTable.name, theme: firmsTable.theme })
    .from(firmsTable)
    .where(eq(firmsTable.id, firmId))
    .limit(1);
  // brandName falls back to the firm's own name — the whitelabel page's rule
  // (themeWithBrandFallback, the invoice-PDF route's exact fallback).
  const theme = themeWithBrandFallback(firm?.theme, firm?.name);
  const pdf = await renderCompliancePackPdf({
    facts,
    coverNote: note.note,
    theme,
  });
  sendPdfAttachment(res, `compliance-pack-${month.slice(0, 7)}.pdf`, pdf);
});

// Tell the client their pack is ready. Firm-side only (a client does not
// notify itself), and pointer-only through and through (SEC-12): the fan-out
// carries a template key and opaque refs — never a month, an amount or a
// contact. Consent (CORE-03) is enforced INSIDE fanOutAlert: a party without
// a live layer-1 grant receives nothing, and the route still answers 202 —
// whether anything was sent is indistinguishable by design, so the endpoint
// can never be used as a consent oracle.
router.post("/compliance-pack/notify", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = requireFirmScope(req.principal);
  const body = parseOrThrow(NotifyCompliancePackBody, req.body);
  // The named client must be one this firm engages — the statement-
  // connections gate on clientPartyId (and a client_user could never reach
  // here past the capability check above).
  await assertPartyAccess(req.principal, body.clientPartyId);
  // The month is advisory (the message itself is pointer-only and names no
  // month) but must still be a real requestable pack month, or the 202 would
  // "acknowledge" a pack that can never exist.
  const month = resolveVatPositionMonth(body.month);
  const [prefs] = await getDb()
    .select()
    .from(alertPreferencesTable)
    .where(eq(alertPreferencesTable.clientPartyId, body.clientPartyId))
    .limit(1);
  await fanOutAlert({
    prefs,
    clientPartyId: body.clientPartyId,
    firmId,
    templateKey: "compliance_pack_ready",
    entityType: "compliance_pack",
    entityId: pointerEntityRef("pack", body.clientPartyId),
    // Mirror the deadline-reminder default: with no prefs row, SMS stays off.
    smsDefaultWhenNoPrefs: false,
  });
  // Pointer-only audit (SEC-12): who asked for which client's pack month —
  // never channels, outcomes (that would leak consent standing) or contacts.
  await appendAudit({
    actorId: req.principal.userId,
    firmId,
    action: "pack.notify",
    entityType: "compliance_pack",
    entityId: pointerEntityRef("pack", body.clientPartyId),
    after: { clientPartyId: body.clientPartyId, month },
  });
  res.status(202).end();
});

export default router;
