import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  membershipsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";
import { assertFirmClerkBudget } from "../clerk/budget";
import { createExtractionCase, type CreateCaseInput } from "../clerk/cases";
import type { ClerkGateway } from "../clerk/gateway";
import { getClerkGateway } from "../clerk/provider";
import { DomainError } from "../errors";

// Inbound email intake (provider-agnostic): a client forwards an invoice to
// the firm's intake address, the email provider's route POSTs it to
// routes/inbound.ts, and each attachment walks the ORDINARY Clerk capture
// path — same 5MB/type/duplicate guards, same per-firm budget, same ledger,
// same human review. The sender's email address is the only identity signal a
// forwarded email carries, so the rail is deliberately narrow: only an
// address that resolves to an existing client_user membership creates
// anything, and everything else is audit-logged and dropped without telling
// the caller (see the anti-probe posture in the route).

// Attachment types the rail accepts. Deliberately narrower than the capture
// module's own image allowlist (no GIF): email scanners emit PDFs and
// photos, and every type here maps 1:1 onto a capture sourceType.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PDF_TYPE = "application/pdf";

export interface InboundAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

export interface InboundEmailInput {
  sender: string;
  subject?: string;
  attachments: InboundAttachment[];
}

export interface ResolvedInboundSender {
  userId: string;
  firmId: string;
  clientPartyId: string | null;
}

export interface InboundProcessResult {
  resolved: boolean;
  caseIds: string[];
  skipped: { filename: string; reason: string }[];
}

// Audit rows must never store a full email address (it is the sender's
// identity, and the ignored path stores addresses we could not even resolve
// to a user): keep the local-part's first 2 chars + the domain.
export function maskInboundSender(sender: string): string {
  const at = sender.indexOf("@");
  if (at === -1) return `${sender.slice(0, 2)}***`;
  return `${sender.slice(0, Math.min(2, at))}***@${sender.slice(at + 1)}`;
}

// Deterministic sender → client resolution: users.email (unique; compared
// lowercased) → that user's memberships → the first client_user row. Staff,
// operator and unknown addresses resolve to nothing — the rail only ever
// captures on behalf of a client. Pre-context reads on the users/memberships
// spine, same posture as principal resolution and creatorClientParty.
export async function resolveInboundSender(
  sender: string,
): Promise<ResolvedInboundSender | null> {
  const email = sender.trim().toLowerCase();
  if (!email) return null;
  return runInBypassContext(async () => {
    const [user] = await getDb()
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = ${email}`)
      .limit(1);
    if (!user) return null;
    const memberships = await getDb()
      .select({
        role: membershipsTable.role,
        firmId: membershipsTable.firmId,
        clientPartyId: membershipsTable.clientPartyId,
      })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, user.id));
    const membership = memberships.find((m) => m.role === "client_user");
    if (!membership?.firmId) return null;
    return {
      userId: user.id,
      firmId: membership.firmId,
      clientPartyId: membership.clientPartyId,
    };
  });
}

// contentType → capture source. Parameters ("; charset=...") are stripped;
// anything unmapped is skipped (audited), never an error back to the
// provider.
function attachmentSource(att: InboundAttachment): CreateCaseInput | null {
  const contentType = att.contentType.split(";")[0].trim().toLowerCase();
  if (contentType === PDF_TYPE) {
    return {
      sourceType: "pdf",
      pdfBase64: att.contentBase64,
      name: att.filename,
      allowDuplicate: false,
    };
  }
  if (IMAGE_TYPES.has(contentType)) {
    return {
      sourceType: "image",
      imageBase64: att.contentBase64,
      contentType,
      name: att.filename,
      allowDuplicate: false,
    };
  }
  return null;
}

// The whole post-response pipeline, exported so tests can await it directly;
// the route calls it detached (.catch(logger.error)) AFTER responding 202.
// Nothing in here may throw for a per-attachment problem: an exhausted
// budget, a duplicate redelivery (providers redeliver on timeout) or an
// oversized file is an audit-skip, and the remaining attachments still
// process. The unresolvable-sender path is handled here too, so the route's
// response can never depend on resolution.
export async function processInboundEmail(
  input: InboundEmailInput,
  gateway?: ClerkGateway,
): Promise<InboundProcessResult> {
  const resolved = await resolveInboundSender(input.sender);
  if (!resolved) {
    // Unknown email, staff/operator email, no client membership: nothing is
    // created, but the drop is durable — masked sender only.
    await appendAudit({
      action: "inbound.email.ignored",
      entityType: "inbound_email",
      entityId: randomUUID(),
      after: {
        sender: maskInboundSender(input.sender),
        attachments: input.attachments.length,
      },
    });
    return { resolved: false, caseIds: [], skipped: [] };
  }

  // Resolved lazily so an email whose attachments all skip (or all hit the
  // budget gate) never needs a provider to be configured at all.
  let gw: ClerkGateway | null = gateway ?? null;
  const caseIds: string[] = [];
  const skipped: { filename: string; reason: string }[] = [];
  for (const att of input.attachments) {
    const source = attachmentSource(att);
    if (!source) {
      skipped.push({ filename: att.filename, reason: "UNSUPPORTED_TYPE" });
      continue;
    }
    try {
      // Same budget gate as the capture route: checked BEFORE the provider is
      // touched, so an exhausted firm spends nothing (the gateway enforces it
      // again as a backstop).
      await assertFirmClerkBudget(resolved.firmId);
      gw ??= await getClerkGateway();
      const kase = await createExtractionCase(
        source,
        resolved.userId,
        gw,
        undefined,
        {
          firmId: resolved.firmId,
          clientScoped: true,
          clientPartyId: resolved.clientPartyId,
        },
      );
      caseIds.push(kase.id);
    } catch (err) {
      // CLERK_BUDGET_EXHAUSTED, DUPLICATE_SOURCE (redelivery), the module's
      // own upload guards, the kill switch — all skip THIS attachment with
      // the domain code on record; nothing escapes the detached promise.
      if (err instanceof DomainError) {
        skipped.push({ filename: att.filename, reason: err.code });
      } else {
        logger.error({ err }, "Inbound email attachment processing failed");
        skipped.push({ filename: att.filename, reason: "ERROR" });
      }
    }
  }

  // Pointer-only receipt: case ids and skip reasons, never attachment content.
  await appendAudit({
    actorId: resolved.userId,
    firmId: resolved.firmId,
    action: "inbound.email.received",
    entityType: "inbound_email",
    entityId: randomUUID(),
    after: {
      sender: maskInboundSender(input.sender),
      caseIds,
      skipped,
    },
  });
  return { resolved: true, caseIds, skipped };
}
