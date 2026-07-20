import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  auditEventsTable,
  membershipsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";
import { normalizeEmail } from "../auth/session";
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

// Volume ceiling (defense in depth next to the token budget): at most this
// many attachments per resolved firm per UTC day walk the capture path; the
// rest audit-skip (still 202 — the anti-probe posture never changes the
// response). Counted deterministically from the rail's own durable receipts
// (the inbound.email.received audit rows), so the cap holds across restarts
// and instances without new state. Read per call so operators (and tests)
// can adjust without a restart.
const DEFAULT_DAILY_CAP = 100;
function dailyAttachmentCap(): number {
  const raw = Number(process.env.INBOUND_EMAIL_DAILY_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_CAP;
}

// In-process concurrency bound on the detached processor: each email can be
// multi-second vision work, and the route fires processing after its 202 —
// without a bound, a webhook burst runs every email at once. Excess emails
// queue here (FIFO) instead of stacking provider calls.
const MAX_CONCURRENT_EMAILS = 2;
let activeEmails = 0;
const emailWaiters: Array<() => void> = [];

function acquireEmailSlot(): Promise<void> {
  if (activeEmails < MAX_CONCURRENT_EMAILS) {
    activeEmails += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    emailWaiters.push(() => {
      activeEmails += 1;
      resolve();
    });
  });
}

function releaseEmailSlot(): void {
  activeEmails -= 1;
  const next = emailWaiters.shift();
  if (next) next();
}

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

// Deterministic sender → client resolution: users.email → that user's
// memberships → the OLDEST client_user row (order by membership createdAt,
// so a multi-membership user always resolves to the same firm/party — an
// unordered scan would let the query plan pick). Staff, operator and unknown
// addresses resolve to nothing — the rail only ever captures on behalf of a
// client. Pre-context reads on the users/memberships spine, same posture as
// principal resolution and creatorClientParty.
//
// The lookup is an EXACT match on the normalized sender (auth/session.ts
// normalizeEmail — the single-normalizer invariant), which uses the unique
// index on users.email. Storage is normalized on every creation path — the
// identity route calls normalizeEmail, invite acceptance normalizes the
// invite's address, and the seed fixtures are lowercase literals — and login
// already relies on exactly this normalized-storage assumption, so no
// lower()-scan fallback is kept.
export async function resolveInboundSender(
  sender: string,
): Promise<ResolvedInboundSender | null> {
  const email = normalizeEmail(sender);
  if (!email) return null;
  return runInBypassContext(async () => {
    const [user] = await getDb()
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (!user) return null;
    const memberships = await getDb()
      .select({
        role: membershipsTable.role,
        firmId: membershipsTable.firmId,
        clientPartyId: membershipsTable.clientPartyId,
      })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, user.id))
      .orderBy(asc(membershipsTable.createdAt));
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

// Attachments already received for this firm today (UTC day), counted from
// the rail's own durable pointer-only receipts: every processed email leaves
// one inbound.email.received audit row whose caseIds + skipped arrays name
// every attachment exactly once. Deterministic, cheap (one indexed-ish
// aggregate over today's rows), and shared across instances/restarts because
// the audit ledger is the state.
async function inboundAttachmentsToday(firmId: string): Promise<number> {
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const [row] = await getDb()
    .select({
      count: sql<number>`coalesce(sum(
        coalesce(jsonb_array_length(${auditEventsTable.after} -> 'caseIds'), 0)
        + coalesce(jsonb_array_length(${auditEventsTable.after} -> 'skipped'), 0)
      ), 0)`,
    })
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "inbound.email.received"),
        eq(auditEventsTable.firmId, firmId),
        gte(auditEventsTable.createdAt, dayStart),
      ),
    );
  return Number(row?.count ?? 0);
}

// The whole post-response pipeline, exported so tests can await it directly;
// the route calls it detached (.catch(logger.error)) AFTER responding 202.
// Nothing in here may throw for a per-attachment problem: an exhausted
// budget, a duplicate redelivery (providers redeliver on timeout) or an
// oversized file is an audit-skip, and the remaining attachments still
// process. The unresolvable-sender path is handled here too, so the route's
// response can never depend on resolution. Bounded by the module-level
// semaphore: at most MAX_CONCURRENT_EMAILS emails process at once, the rest
// queue in-process (the caller's 202 already went out either way).
export async function processInboundEmail(
  input: InboundEmailInput,
  gateway?: ClerkGateway,
): Promise<InboundProcessResult> {
  await acquireEmailSlot();
  try {
    return await processInboundEmailNow(input, gateway);
  } finally {
    releaseEmailSlot();
  }
}

async function processInboundEmailNow(
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

  // Daily volume ceiling per resolved firm: attachments beyond the remaining
  // allowance audit-skip like any other per-attachment refusal — the sender
  // never sees a different response (anti-probe), and the skip reason lands
  // in the durable receipt.
  const usedToday = await inboundAttachmentsToday(resolved.firmId);
  let remaining = Math.max(0, dailyAttachmentCap() - usedToday);

  // Resolved lazily so an email whose attachments all skip (or all hit the
  // budget gate) never needs a provider to be configured at all.
  let gw: ClerkGateway | null = gateway ?? null;
  const caseIds: string[] = [];
  const skipped: { filename: string; reason: string }[] = [];
  for (const att of input.attachments) {
    if (remaining <= 0) {
      skipped.push({ filename: att.filename, reason: "INBOUND_DAILY_CAP" });
      continue;
    }
    // Every attachment the rail even LOOKS at consumes allowance (matching
    // the receipt-based count above, which sums caseIds + skipped) — a flood
    // of unsupported or duplicate files is still a flood.
    remaining -= 1;
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
