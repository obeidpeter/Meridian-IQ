import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, auditEventsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";
import { assertFirmClerkBudget } from "../clerk/budget";
import { createExtractionCase, type CreateCaseInput } from "../clerk/cases";
import type { ClerkGateway } from "../clerk/gateway";
import { getClerkGateway } from "../clerk/provider";
import { DomainError } from "../errors";
import { pdfTextHeadForTriage, triageDocumentKind } from "./triage";

// Machinery shared by the inbound intake rails (email, WhatsApp). Both rails
// have the same shape — an unauthenticated-ish machine webhook that resolves
// a sender to a client and walks attachments through the ordinary Clerk
// capture path — so the volume ceiling, the concurrency bound, the
// attachment→capture-source mapping and the per-item capture closure live
// here once.

export interface InboundAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

// Attachment types the rails accept, keyed to the extension a derived
// filename gets — the ONE home for the type set, read by both the
// attachmentSource allowlist below and the WhatsApp rail's filename
// derivation, so a newly allowlisted type can never silently arrive named
// ".jpg". Deliberately narrower than the capture module's own image
// allowlist (no GIF): email scanners and WhatsApp media are PDFs and photos,
// and every type here maps 1:1 onto a capture sourceType.
export const EXTENSION_BY_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const PDF_TYPE = "application/pdf";
const IMAGE_TYPES = new Set(
  Object.keys(EXTENSION_BY_TYPE).filter((t) => t !== PDF_TYPE),
);

// The ONE contentType normalization both the allowlist and the filename
// derivation apply: parameters ("; charset=...") stripped, lowercased.
export function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

// contentType → capture source. Anything unmapped is skipped (audited by the
// caller), never an error back to the provider.
export function attachmentSource(
  att: InboundAttachment,
): CreateCaseInput | null {
  const contentType = normalizeContentType(att.contentType);
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

// In-process concurrency bound inside each outbox worker: an inbound message
// can involve multi-second vision work. One semaphore spans both rails so a
// burst cannot stack unbounded provider calls; excess claimed work waits FIFO.
const MAX_CONCURRENT_INBOUND = 2;
let activeInbound = 0;
const inboundWaiters: Array<() => void> = [];

function acquireInboundSlot(): Promise<void> {
  if (activeInbound < MAX_CONCURRENT_INBOUND) {
    activeInbound += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    inboundWaiters.push(() => {
      activeInbound += 1;
      resolve();
    });
  });
}

function releaseInboundSlot(): void {
  activeInbound -= 1;
  const next = inboundWaiters.shift();
  if (next) next();
}

export async function withInboundSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireInboundSlot();
  try {
    return await fn();
  } finally {
    releaseInboundSlot();
  }
}

// Volume ceiling (defense in depth next to the token budget): at most this
// many attachments per resolved firm per UTC day walk the capture path; the
// rest audit-skip (still 202 — the anti-probe posture never changes the
// response). Read per call so operators (and tests) can adjust without a
// restart. Each rail has its own env knob and its own count.
const DEFAULT_DAILY_CAP = 100;
export function dailyCapFromEnv(envName: string): number {
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_CAP;
}

// Attachments already received for this firm today (UTC day), counted from
// the rail's own durable pointer-only receipts: every processed message
// leaves one <action> audit row whose caseIds + skipped arrays name every
// attachment exactly once. Deterministic, cheap (one indexed-ish aggregate
// over today's rows), and shared across instances/restarts because the audit
// ledger is the state.
export async function inboundAttachmentsToday(
  action: string,
  firmId: string,
): Promise<number> {
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
        eq(auditEventsTable.action, action),
        eq(auditEventsTable.firmId, firmId),
        gte(auditEventsTable.createdAt, dayStart),
      ),
    );
  return Number(row?.count ?? 0);
}

// Today's remaining allowance for a resolved firm on one rail: the rail's env
// cap minus the receipt-counted usage, floored at zero. Both rails burn this
// number down item by item.
export async function remainingInboundAllowance(
  action: string,
  envName: string,
  firmId: string,
): Promise<number> {
  const usedToday = await inboundAttachmentsToday(action, firmId);
  return Math.max(0, dailyCapFromEnv(envName) - usedToday);
}

// The identity every capture on an inbound rail is stamped with.
export interface ResolvedInboundClient {
  userId: string;
  firmId: string;
  clientPartyId: string | null;
}

// One skip entry in a rail's receipt: which item, and the domain code why.
export type InboundSkip = { filename: string; reason: string };

// What both rails' outbox processors report: whether the sender resolved,
// plus the caseIds/skipped arrays their pointer-only receipt is built from.
export interface InboundProcessResult {
  resolved: boolean;
  caseIds: string[];
  skipped: InboundSkip[];
}

// The per-item capture closure both rails share: budget gate BEFORE the
// provider (the capture-route idiom — the gateway enforces it again as a
// backstop), gateway resolved lazily so a message whose items all skip never
// needs a provider configured at all, and NOTHING throws for a per-item
// problem — CLERK_BUDGET_EXHAUSTED, DUPLICATE_SOURCE (providers redeliver on
// timeout), the module's own upload guards and the kill switch all skip THIS
// item with the domain code on record, so one item cannot abort the whole
// message. Results accumulate on the returned caseIds/skipped arrays, which
// the caller folds into its pointer-only receipt.
//
// Between budget/gateway acquisition and the capture call, each ATTACHMENT
// (pdf/image — never the WhatsApp text-only path) gets one cheap triage call
// (./triage.ts) that can route it down the notice lane instead of the
// invoice lane. `messageText` is the rail's message signal (email subject /
// WhatsApp caption). Triage inherits this closure's absorption contract from
// its own never-throws guarantee: any triage failure means documentKind stays
// absent and the item walks the invoice lane exactly as it did before triage
// existed — a triage problem is NEVER a skip.
export function makeInboundCapture(
  resolved: ResolvedInboundClient,
  gateway: ClerkGateway | undefined,
  logLabel: string,
): {
  capture: (
    filename: string,
    source: CreateCaseInput,
    messageText?: string | null,
  ) => Promise<void>;
  caseIds: string[];
  skipped: InboundSkip[];
} {
  let gw: ClerkGateway | null = gateway ?? null;
  const caseIds: string[] = [];
  const skipped: InboundSkip[] = [];
  const capture = async (
    filename: string,
    source: CreateCaseInput,
    messageText: string | null = null,
  ): Promise<void> => {
    try {
      await assertFirmClerkBudget(resolved.firmId);
      gw ??= await getClerkGateway();
      let documentKind: "invoice" | "notice" | undefined;
      if (source.sourceType === "pdf" || source.sourceType === "image") {
        documentKind = await triageDocumentKind(gw, resolved.firmId, {
          filename,
          contentType:
            source.sourceType === "pdf"
              ? "application/pdf"
              : (source.contentType ?? "image"),
          messageText,
          // The head extraction re-parses bytes the capture path will parse
          // again — acceptable at the rails' scale (≤3 attachments/message,
          // daily caps ~100); null (textless scan, bad bytes) just narrows
          // triage to the filename + message signals.
          pdfTextHead:
            source.sourceType === "pdf" && source.pdfBase64
              ? await pdfTextHeadForTriage(source.pdfBase64)
              : null,
        });
      }
      const kase = await createExtractionCase(
        documentKind ? { ...source, documentKind } : source,
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
      if (err instanceof DomainError) {
        skipped.push({ filename, reason: err.code });
      } else {
        logger.error({ err }, `${logLabel} processing failed`);
        skipped.push({ filename, reason: "ERROR" });
      }
    }
  };
  return { capture, caseIds, skipped };
}

// The per-attachment loop both rails drive through the capture closure
// above, in the ONE order the receipts depend on: cap-check → decrement →
// type-map → capture. Every item the rail even LOOKS at consumes allowance
// BEFORE the type check (matching the receipt-based count above, which sums
// caseIds + skipped) — a flood of unsupported or duplicate files/media is
// still a flood. `messageText` is the rail's message signal (email subject /
// WhatsApp caption), threaded to triage through the capture closure; the
// WhatsApp rail derives default filenames before calling so even a
// cap-skipped item's receipt entry carries its name. Returns the post-loop
// remaining allowance so a rail's tail work (the WhatsApp text-only path)
// sees the correct number.
export async function captureInboundAttachments(
  attachments: InboundAttachment[],
  messageText: string | null,
  remaining: number,
  capture: (
    filename: string,
    source: CreateCaseInput,
    messageText?: string | null,
  ) => Promise<void>,
  skipped: InboundSkip[],
): Promise<number> {
  for (const att of attachments) {
    if (remaining <= 0) {
      skipped.push({ filename: att.filename, reason: "INBOUND_DAILY_CAP" });
      continue;
    }
    remaining -= 1;
    const source = attachmentSource(att);
    if (!source) {
      skipped.push({ filename: att.filename, reason: "UNSUPPORTED_TYPE" });
      continue;
    }
    await capture(att.filename, source, messageText);
  }
  return remaining;
}

// The pointer-only receipt both rails append after processing: case ids and
// skip reasons, never message or attachment content. The after-shape is
// LOAD-BEARING — inboundAttachmentsToday above counts a firm's daily usage
// by summing caseIds + skipped out of exactly this JSON — so it lives here,
// next to the counter it feeds, instead of hand-rolled per rail. The sender
// is masked by the CALLER: each rail masks its own identity type.
export async function appendInboundReceipt(
  rail: { action: string; entityType: string },
  resolved: ResolvedInboundClient,
  maskedSender: string,
  caseIds: string[],
  skipped: InboundSkip[],
): Promise<void> {
  await appendAudit({
    actorId: resolved.userId,
    firmId: resolved.firmId,
    action: rail.action,
    entityType: rail.entityType,
    entityId: randomUUID(),
    after: {
      sender: maskedSender,
      caseIds,
      skipped,
    },
  });
}
