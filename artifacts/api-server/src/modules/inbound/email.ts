import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  membershipsTable,
  usersTable,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { normalizeEmail } from "../auth/session";
import type { ClerkGateway } from "../clerk/gateway";
import {
  attachmentSource,
  makeInboundCapture,
  remainingInboundAllowance,
  withInboundSlot,
  type InboundAttachment,
} from "./shared";

// Inbound email intake (provider-agnostic): a client forwards an invoice to
// the firm's intake address, the email provider's route POSTs it to
// routes/inbound.ts, and each attachment walks the ORDINARY Clerk capture
// path — same 5MB/type/duplicate guards, same per-firm budget, same ledger,
// same human review. The sender's email address is the only identity signal a
// forwarded email carries, so the rail is deliberately narrow: only an
// address that resolves to an existing client_user membership creates
// anything, and everything else is audit-logged and dropped without telling
// the caller (see the anti-probe posture in the route).

// The attachment allowlist, the per-firm daily cap and the process-wide
// concurrency bound live in ./shared.ts — the WhatsApp rail uses exactly the
// same machinery. This rail's cap counts the inbound.email.received audit
// receipts under INBOUND_EMAIL_DAILY_CAP.
export type { InboundAttachment } from "./shared";

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

// The whole post-response pipeline, exported so tests can await it directly;
// the route calls it detached (.catch(logger.error)) AFTER responding 202.
// Nothing in here may throw for a per-attachment problem: an exhausted
// budget, a duplicate redelivery (providers redeliver on timeout) or an
// oversized file is an audit-skip, and the remaining attachments still
// process. The unresolvable-sender path is handled here too, so the route's
// response can never depend on resolution. Bounded by the shared inbound
// semaphore: at most two inbound messages (across BOTH rails) process at
// once, the rest queue in-process (the caller's 202 already went out either
// way).
export async function processInboundEmail(
  input: InboundEmailInput,
  gateway?: ClerkGateway,
): Promise<InboundProcessResult> {
  return withInboundSlot(() => processInboundEmailNow(input, gateway));
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
  let remaining = await remainingInboundAllowance(
    "inbound.email.received",
    "INBOUND_EMAIL_DAILY_CAP",
    resolved.firmId,
  );

  // Shared per-item capture closure (./shared.ts): budget gate before the
  // provider, lazy gateway, every per-attachment failure absorbed as a skip.
  const { capture, caseIds, skipped } = makeInboundCapture(
    resolved,
    gateway,
    "Inbound email attachment",
  );
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
    await capture(att.filename, source);
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
