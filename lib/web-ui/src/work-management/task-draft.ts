import type { CollaborativeWorkPriority } from "./types";

export interface WorkDraft {
  title: string;
  description: string;
  clientPartyId: string;
  priority: CollaborativeWorkPriority;
  dueDate: string;
  assignedTo: string;
}

export interface WorkAttempt {
  signature: string;
  id: string;
}

export const EMPTY_DRAFT: WorkDraft = {
  title: "",
  description: "",
  clientPartyId: "",
  priority: "normal",
  dueDate: "",
  assignedTo: "",
};

export function readDraft(key: string | undefined): WorkDraft {
  if (!key || typeof window === "undefined") return EMPTY_DRAFT;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(key) ?? "null",
    ) as Partial<WorkDraft> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY_DRAFT;
    const priority = ["low", "normal", "high", "urgent"].includes(
      String(parsed.priority),
    )
      ? (parsed.priority as CollaborativeWorkPriority)
      : "normal";
    return {
      title: typeof parsed.title === "string" ? parsed.title.slice(0, 160) : "",
      description:
        typeof parsed.description === "string"
          ? parsed.description.slice(0, 2000)
          : "",
      clientPartyId:
        typeof parsed.clientPartyId === "string" ? parsed.clientPartyId : "",
      priority,
      dueDate:
        typeof parsed.dueDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate)
          ? parsed.dueDate
          : "",
      assignedTo:
        typeof parsed.assignedTo === "string" ? parsed.assignedTo : "",
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

// Drafts written before the key carried firm and client scope (R116) move
// to the scoped key once, so a saved draft is not lost by the change; a
// draft already under the scoped key wins and the legacy copy is dropped.
export function adoptLegacyDraft(
  legacyKey: string | undefined,
  key: string | undefined,
): void {
  if (!legacyKey || !key || legacyKey === key || typeof window === "undefined")
    return;
  try {
    for (const suffix of ["", ":attempt"]) {
      const legacy = window.localStorage.getItem(`${legacyKey}${suffix}`);
      if (legacy === null) continue;
      if (window.localStorage.getItem(`${key}${suffix}`) === null) {
        window.localStorage.setItem(`${key}${suffix}`, legacy);
      }
      window.localStorage.removeItem(`${legacyKey}${suffix}`);
    }
  } catch {
    // Storage unavailable: there is nothing to adopt.
  }
}

export function readAttempt(key: string | undefined): WorkAttempt | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(`${key}:attempt`) ?? "null",
    ) as Partial<WorkAttempt> | null;
    if (
      !parsed ||
      typeof parsed.signature !== "string" ||
      parsed.signature.length > 3_000 ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.id,
      )
    ) {
      return null;
    }
    return { signature: parsed.signature, id: parsed.id };
  } catch {
    return null;
  }
}
