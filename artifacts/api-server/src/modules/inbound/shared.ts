import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, auditEventsTable } from "@workspace/db";
import type { CreateCaseInput } from "../clerk/cases";

// Machinery shared by the inbound intake rails (email, WhatsApp). Both rails
// have the same shape — an unauthenticated-ish machine webhook that resolves
// a sender to a client and walks attachments through the ordinary Clerk
// capture path — so the volume ceiling, the concurrency bound and the
// attachment→capture-source mapping live here once.

export interface InboundAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

// Attachment types the rails accept. Deliberately narrower than the capture
// module's own image allowlist (no GIF): email scanners and WhatsApp media
// are PDFs and photos, and every type here maps 1:1 onto a capture
// sourceType.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PDF_TYPE = "application/pdf";

// contentType → capture source. Parameters ("; charset=...") are stripped;
// anything unmapped is skipped (audited by the caller), never an error back
// to the provider.
export function attachmentSource(att: InboundAttachment): CreateCaseInput | null {
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

// In-process concurrency bound on the detached processors: each inbound
// message can be multi-second vision work, and the routes fire processing
// after their 202 — without a bound, a webhook burst runs everything at
// once. ONE semaphore across BOTH rails on purpose: the bound exists to cap
// concurrent provider work, and the provider does not care which rail the
// work arrived on. Excess messages queue here (FIFO) instead of stacking
// provider calls.
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
