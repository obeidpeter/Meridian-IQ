import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  alertPreferencesTable,
  membershipsTable,
} from "@workspace/db";
import { normalizePhone } from "../../lib/phone";
import { appendAudit } from "../audit/audit";
import type { ClerkGateway } from "../clerk/gateway";
import {
  attachmentSource,
  makeInboundCapture,
  remainingInboundAllowance,
  withInboundSlot,
  type InboundAttachment,
} from "./shared";

// Inbound WhatsApp intake (provider-agnostic): a client sends an invoice
// photo/PDF (or types the details) to the firm's WhatsApp number, the BSP's
// webhook relay POSTs it to routes/inbound.ts, and each piece of media walks
// the ORDINARY Clerk capture path — same 5MB/type/duplicate guards, same
// per-firm budget, same ledger, same human review. Mirrors the email rail's
// posture exactly (fail-closed token, anti-probe 202, detached processing,
// per-firm daily cap via ./shared.ts, masked audits).
//
// The sender's phone number is the only identity signal a WhatsApp message
// carries, so resolution is deliberately narrow AND deliberately cautious:
// the normalized sender is matched against the numbers clients stored on
// their own alert_preferences rows (whatsappTo / phone — free text, so the
// STORED value is normalized at compare time too), and only an EXACTLY-ONE
// party match resolves. Zero matches or multiple parties sharing a number
// audit-skip — ambiguity refuses, never guesses, because a wrong guess would
// file one client's document into a sibling's book.

// A text-only message shorter than this is a greeting or a "thanks", not an
// invoice: audit-skip it instead of burning budget on a model call.
export const MIN_TEXT_CHARS = 40;

// WhatsApp media often arrives without a filename; the capture path wants
// one for the case's sourceName.
function mediaFilename(att: InboundWhatsAppAttachment, index: number): string {
  if (att.filename) return att.filename;
  const contentType = att.contentType.split(";")[0].trim().toLowerCase();
  const ext =
    contentType === "application/pdf"
      ? "pdf"
      : contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
          ? "webp"
          : "jpg";
  return `whatsapp-media-${index + 1}.${ext}`;
}

export interface InboundWhatsAppAttachment {
  filename?: string;
  contentType: string;
  contentBase64: string;
}

export interface InboundWhatsAppInput {
  sender: string; // phone number, any human formatting
  text?: string;
  attachments: InboundWhatsAppAttachment[];
}

export interface ResolvedInboundWhatsAppSender {
  userId: string; // oldest client_user membership — same rule as email.ts
  firmId: string;
  clientPartyId: string;
}

export type WhatsAppSenderResolution =
  | { ok: true; resolved: ResolvedInboundWhatsAppSender }
  | {
      ok: false;
      reason: "invalid_phone" | "no_match" | "ambiguous" | "no_membership";
    };

export interface InboundWhatsAppResult {
  resolved: boolean;
  caseIds: string[];
  skipped: { filename: string; reason: string }[];
}

// Audit rows must never store a full phone number (the ignored path stores
// numbers we could not even resolve to a client): keep the last 4 digits
// only.
export function maskInboundPhone(sender: string): string {
  const digits = sender.replace(/\D/g, "");
  return `***${digits.slice(-4)}`;
}

// Deterministic sender → client resolution:
//  1. normalize the webhook's sender through the ONE shared normalizer
//     (lib/phone.ts);
//  2. compare against every alert_preferences row that stores a WhatsApp or
//     phone number AND whose contact fields the CLIENT set themselves
//     (contact_set_by_role = 'client_user') — the stored values are free text
//     used here as a global routing key, and a firm-staff-typed number must
//     never be able to route documents into a client's book (a number becomes
//     a routing key only when the client set it themselves; rows predating
//     the provenance column fail closed and do not route). Values are
//     normalized through the SAME function at compare time (fetch-and-filter:
//     the table is one small row per client party, and normalizing in SQL
//     would fork the normalizer);
//  3. EXACTLY ONE matching client party resolves; zero or several refuse
//     (the caller audit-skips) — a shared office number must never guess;
//  4. firm + acting user come from the party's OLDEST client_user membership
//     (order by membership createdAt — email.ts's rule: a multi-membership
//     party always resolves to the same firm/creator; the membership row
//     carries firmId).
// Pre-context reads in the bypass context, same posture as the email rail's
// resolution.
export async function resolveInboundWhatsAppSender(
  sender: string,
): Promise<WhatsAppSenderResolution> {
  const normalized = normalizePhone(sender);
  if (!normalized) return { ok: false, reason: "invalid_phone" };
  return runInBypassContext(async () => {
    const rows = await getDb()
      .select({
        clientPartyId: alertPreferencesTable.clientPartyId,
        whatsappTo: alertPreferencesTable.whatsappTo,
        phone: alertPreferencesTable.phone,
      })
      .from(alertPreferencesTable)
      .where(
        and(
          or(
            isNotNull(alertPreferencesTable.whatsappTo),
            isNotNull(alertPreferencesTable.phone),
          ),
          // Provenance gate: only client-set numbers are routing keys.
          eq(alertPreferencesTable.contactSetByRole, "client_user"),
        ),
      );
    // clientPartyId is the table's primary key, so each row is one party;
    // either stored number matching counts.
    const matches = rows.filter(
      (r) =>
        (r.whatsappTo !== null && normalizePhone(r.whatsappTo) === normalized) ||
        (r.phone !== null && normalizePhone(r.phone) === normalized),
    );
    if (matches.length === 0) return { ok: false, reason: "no_match" };
    if (matches.length > 1) return { ok: false, reason: "ambiguous" };
    const clientPartyId = matches[0].clientPartyId;
    const [membership] = await getDb()
      .select({
        userId: membershipsTable.userId,
        firmId: membershipsTable.firmId,
      })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.clientPartyId, clientPartyId),
          eq(membershipsTable.role, "client_user"),
        ),
      )
      .orderBy(asc(membershipsTable.createdAt))
      .limit(1);
    if (!membership?.firmId) return { ok: false, reason: "no_membership" };
    return {
      ok: true,
      resolved: {
        userId: membership.userId,
        firmId: membership.firmId,
        clientPartyId,
      },
    };
  });
}

// The whole post-response pipeline, exported so tests can await it directly;
// the route calls it detached (.catch(logger.error)) AFTER responding 202.
// Same contract as processInboundEmail: nothing in here may throw for a
// per-item problem, the unresolvable-sender path is handled here so the
// route's response can never depend on resolution, and the shared inbound
// semaphore bounds concurrent provider work across both rails.
export async function processInboundWhatsApp(
  input: InboundWhatsAppInput,
  gateway?: ClerkGateway,
): Promise<InboundWhatsAppResult> {
  return withInboundSlot(() => processInboundWhatsAppNow(input, gateway));
}

async function processInboundWhatsAppNow(
  input: InboundWhatsAppInput,
  gateway?: ClerkGateway,
): Promise<InboundWhatsAppResult> {
  const resolution = await resolveInboundWhatsAppSender(input.sender);
  if (!resolution.ok) {
    // Unknown number, a number shared by several client parties, a party
    // with no membership: nothing is created, but the drop is durable —
    // masked number and the refusal reason only.
    await appendAudit({
      action: "inbound.whatsapp.ignored",
      entityType: "inbound_whatsapp",
      entityId: randomUUID(),
      after: {
        sender: maskInboundPhone(input.sender),
        reason: resolution.reason,
        attachments: input.attachments.length,
        hasText: Boolean(input.text?.trim()),
      },
    });
    return { resolved: false, caseIds: [], skipped: [] };
  }
  const { resolved } = resolution;

  // Daily volume ceiling per resolved firm, counted from this rail's own
  // durable receipts (same machinery as the email rail, separate knob and
  // separate count). A text-only message consumes allowance like an
  // attachment: it lands in caseIds or skipped either way, which is exactly
  // what the receipt-based count sums.
  let remaining = await remainingInboundAllowance(
    "inbound.whatsapp.received",
    "INBOUND_WHATSAPP_DAILY_CAP",
    resolved.firmId,
  );

  // Shared per-item capture closure (./shared.ts): budget gate before the
  // provider, lazy gateway, every per-item failure (BSPs redeliver on
  // timeout) absorbed as a skip.
  const { capture, caseIds, skipped } = makeInboundCapture(
    resolved,
    gateway,
    "Inbound WhatsApp item",
  );

  for (const [index, att] of input.attachments.entries()) {
    const filename = mediaFilename(att, index);
    if (remaining <= 0) {
      skipped.push({ filename, reason: "INBOUND_DAILY_CAP" });
      continue;
    }
    // Every item the rail even LOOKS at consumes allowance (matching the
    // receipt-based count above) — a flood of unsupported or duplicate media
    // is still a flood.
    remaining -= 1;
    const source = attachmentSource({
      filename,
      contentType: att.contentType,
      contentBase64: att.contentBase64,
    } satisfies InboundAttachment);
    if (!source) {
      skipped.push({ filename, reason: "UNSUPPORTED_TYPE" });
      continue;
    }
    await capture(filename, source);
  }

  // A text-only message (no media) walks the TEXT capture path — but only
  // when it plausibly carries invoice details. Text alongside media is a
  // caption, not a document: it is ignored, exactly like the email rail
  // ignores the subject line.
  const text = input.text?.trim() ?? "";
  if (input.attachments.length === 0 && text) {
    const filename = "whatsapp-message";
    if (remaining <= 0) {
      skipped.push({ filename, reason: "INBOUND_DAILY_CAP" });
    } else if (text.length < MIN_TEXT_CHARS) {
      skipped.push({ filename, reason: "TEXT_TOO_SHORT" });
    } else {
      await capture(filename, {
        sourceType: "text",
        text: input.text,
        name: filename,
        allowDuplicate: false,
      });
    }
  }

  // Pointer-only receipt: case ids and skip reasons, never message content.
  await appendAudit({
    actorId: resolved.userId,
    firmId: resolved.firmId,
    action: "inbound.whatsapp.received",
    entityType: "inbound_whatsapp",
    entityId: randomUUID(),
    after: {
      sender: maskInboundPhone(input.sender),
      caseIds,
      skipped,
    },
  });
  return { resolved: true, caseIds, skipped };
}
