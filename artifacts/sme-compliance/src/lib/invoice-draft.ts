import {
  draftHasWork,
  emptyLine,
  todayIsoDate,
  type LineDraft,
} from "@/lib/invoice-lines";

export const DRAFT_KEY = "meridianiq:invoice-draft";
export const INVOICE_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DraftState {
  invoiceNumber: string;
  buyerPartyId: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  fxRateToNgn: string;
  whtCategory: string;
  lines: LineDraft[];
}

interface DraftEnvelope {
  version: 1;
  savedAt: string;
  expiresAt: string;
  draft: DraftState;
}

export function draftStorageKey(
  userId: string,
  firmId?: string | null,
): string {
  return `${DRAFT_KEY}:${firmId ?? "no-firm"}:${userId}`;
}

export function emptyInvoiceDraft(): DraftState {
  return {
    invoiceNumber: "",
    buyerPartyId: "",
    issueDate: todayIsoDate(),
    dueDate: "",
    currency: "NGN",
    fxRateToNgn: "",
    whtCategory: "",
    lines: [emptyLine()],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDraft(value: unknown): DraftState | null {
  if (!isObject(value)) return null;
  const fallback = emptyInvoiceDraft();
  const text = (key: keyof DraftState, defaultValue = "") =>
    typeof value[key] === "string" ? (value[key] as string) : defaultValue;
  const lines = Array.isArray(value.lines)
    ? value.lines.flatMap((line) => {
        if (!isObject(line)) return [];
        const fields = ["description", "quantity", "unitPrice", "vatRate"];
        if (!fields.every((field) => typeof line[field] === "string"))
          return [];
        return [
          {
            description: line.description as string,
            quantity: line.quantity as string,
            unitPrice: line.unitPrice as string,
            vatRate: line.vatRate as string,
          },
        ];
      })
    : [];
  return {
    invoiceNumber: text("invoiceNumber"),
    buyerPartyId: text("buyerPartyId"),
    issueDate: text("issueDate", fallback.issueDate),
    dueDate: text("dueDate"),
    currency: text("currency", fallback.currency),
    fxRateToNgn: text("fxRateToNgn"),
    whtCategory: text("whtCategory"),
    lines: lines.length > 0 ? lines : fallback.lines,
  };
}

function removeFrom(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Blocked storage must not break the form itself.
  }
}

export function removeInvoiceDraft(key: string): void {
  if (typeof window === "undefined") return;
  try {
    removeFrom(window.localStorage, key);
  } catch {
    // Access can itself be denied by the browser's storage policy.
  }
  try {
    removeFrom(window.sessionStorage, key);
  } catch {
    // Access can itself be denied by the browser's storage policy.
  }
}

export function loadInvoiceDraft(
  key: string,
  now = new Date(),
): { draft: DraftState; restored: boolean; savedAt: Date | null } {
  const empty = emptyInvoiceDraft();
  if (typeof window === "undefined") {
    return { draft: empty, restored: false, savedAt: null };
  }

  let storages: Storage[];
  try {
    storages = [window.localStorage, window.sessionStorage];
  } catch {
    return { draft: empty, restored: false, savedAt: null };
  }
  for (const storage of storages) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      continue;
    }
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed) && parsed.version === 1 && "draft" in parsed) {
        const expiresAt = Date.parse(String(parsed.expiresAt ?? ""));
        const savedAt = new Date(String(parsed.savedAt ?? ""));
        if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
          removeInvoiceDraft(key);
          return { draft: empty, restored: false, savedAt: null };
        }
        const draft = normalizeDraft(parsed.draft);
        if (!draft) throw new Error("Invalid draft envelope");
        return {
          draft,
          restored: draftHasWork(draft),
          savedAt: Number.isFinite(savedAt.getTime()) ? savedAt : now,
        };
      }

      // Compatibility with drafts written before retention envelopes existed.
      // The next debounced save migrates them into the seven-day format.
      const draft = normalizeDraft(parsed);
      if (!draft) throw new Error("Invalid legacy draft");
      return { draft, restored: draftHasWork(draft), savedAt: now };
    } catch {
      removeFrom(storage, key);
    }
  }
  return { draft: empty, restored: false, savedAt: null };
}

export function saveInvoiceDraft(
  key: string,
  draft: DraftState,
  now = new Date(),
): Date | null {
  if (typeof window === "undefined") return null;
  const envelope: DraftEnvelope = {
    version: 1,
    savedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVOICE_DRAFT_TTL_MS).toISOString(),
    draft,
  };
  try {
    window.localStorage.setItem(key, JSON.stringify(envelope));
    removeFrom(window.sessionStorage, key);
    return now;
  } catch {
    return null;
  }
}

export function storedInvoiceDraftHasWork(key: string): boolean {
  return loadInvoiceDraft(key).restored;
}
