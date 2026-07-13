import { and, desc, eq, isNull, lte, or, gte, sql } from "drizzle-orm";
import {
  getDb,
  claimRecordsTable,
  type ClaimRecord,
  type ProtectedFact,
  type ClaimApplicability,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";

// Claims register lifecycle (Task #40, C0). A claim's protected facts are the
// ONLY compliance numbers the Clerk may surface. Lifecycle:
//   draft -> review -> active | rejected
//   active -> suspended (operator pause) -> active (resume)
//   active -> superseded (automatically, when a newer version is approved)
// Maker-checker: the author (createdBy) or submitter of a version can NEVER
// approve that version. Enforced here, not just in UI.

export interface ClaimDraftInput {
  claimKey: string;
  title: string;
  proposition: string;
  protectedFacts: ProtectedFact[];
  citation: string;
  applicability?: ClaimApplicability;
  effectiveFrom: string;
  effectiveTo?: string | null;
  reviewDueAt?: string | null;
}

export async function listClaims(claimKey?: string): Promise<ClaimRecord[]> {
  const where = claimKey ? eq(claimRecordsTable.claimKey, claimKey) : undefined;
  return getDb()
    .select()
    .from(claimRecordsTable)
    .where(where)
    .orderBy(
      claimRecordsTable.claimKey,
      desc(claimRecordsTable.version),
    );
}

export async function getClaim(id: string): Promise<ClaimRecord> {
  const [row] = await getDb()
    .select()
    .from(claimRecordsTable)
    .where(eq(claimRecordsTable.id, id))
    .limit(1);
  if (!row) throw new DomainError("CLAIM_NOT_FOUND", "Claim not found", 404);
  return row;
}

// Active register slice used by Ask Clerk: approved AND in-date today.
// The ANSWERABLE set (CLK-KB-07): active, inside the effective window, and
// not overdue for review — a stale record is register-visible but cannot
// answer until Tax/Counsel re-confirm it.
export async function getActiveClaims(): Promise<ClaimRecord[]> {
  const today = new Date().toISOString().slice(0, 10);
  return getDb()
    .select()
    .from(claimRecordsTable)
    .where(
      and(
        eq(claimRecordsTable.state, "active"),
        lte(claimRecordsTable.effectiveFrom, today),
        or(
          isNull(claimRecordsTable.effectiveTo),
          gte(claimRecordsTable.effectiveTo, today),
        ),
        or(
          isNull(claimRecordsTable.reviewDueAt),
          gte(claimRecordsTable.reviewDueAt, today),
        ),
      ),
    )
    .orderBy(claimRecordsTable.claimKey);
}

// Expiry sweep: an active claim whose effective-to has passed flips to
// expired (audited), so the register reflects reality without waiting for a
// human to notice. Runs from the shared sweep registry.
export async function sweepExpiredClaims(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await getDb()
    .update(claimRecordsTable)
    .set({ state: "expired" })
    .where(
      and(
        eq(claimRecordsTable.state, "active"),
        sql`${claimRecordsTable.effectiveTo} IS NOT NULL AND ${claimRecordsTable.effectiveTo} < ${today}`,
      ),
    )
    .returning({ id: claimRecordsTable.id, claimKey: claimRecordsTable.claimKey });
  for (const row of rows) {
    await appendAudit({
      actorId: "clerk-sweep",
      actorRole: "system",
      action: "clerk.claim.expired",
      entityType: "claim_record",
      entityId: row.id,
      after: { claimKey: row.claimKey },
    });
  }
  return rows.length;
}

export async function createClaimDraft(
  input: ClaimDraftInput,
  actorId: string,
): Promise<ClaimRecord> {
  const [{ maxVersion }] = await getDb()
    .select({
      maxVersion: sql<number>`coalesce(max(${claimRecordsTable.version}), 0)::int`,
    })
    .from(claimRecordsTable)
    .where(eq(claimRecordsTable.claimKey, input.claimKey));
  const [row] = await getDb()
    .insert(claimRecordsTable)
    .values({
      claimKey: input.claimKey,
      version: maxVersion + 1,
      state: "draft",
      title: input.title,
      proposition: input.proposition,
      protectedFacts: input.protectedFacts,
      citation: input.citation,
      applicability: input.applicability ?? {},
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      reviewDueAt: input.reviewDueAt ?? null,
      createdBy: actorId,
    })
    .returning();
  return row;
}

export async function updateClaimDraft(
  id: string,
  patch: Partial<Omit<ClaimDraftInput, "claimKey">>,
  _actorId: string,
): Promise<ClaimRecord> {
  const existing = await getClaim(id);
  if (existing.state !== "draft") {
    throw new DomainError(
      "CLAIM_BAD_STATE",
      `Only draft claims can be edited (state is '${existing.state}'). Create a new version instead.`,
      409,
    );
  }
  const [row] = await getDb()
    .update(claimRecordsTable)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.proposition !== undefined
        ? { proposition: patch.proposition }
        : {}),
      ...(patch.protectedFacts !== undefined
        ? { protectedFacts: patch.protectedFacts }
        : {}),
      ...(patch.citation !== undefined ? { citation: patch.citation } : {}),
      ...(patch.applicability !== undefined
        ? { applicability: patch.applicability }
        : {}),
      ...(patch.effectiveFrom !== undefined
        ? { effectiveFrom: patch.effectiveFrom }
        : {}),
      ...(patch.reviewDueAt !== undefined
        ? { reviewDueAt: patch.reviewDueAt ?? null }
        : {}),
      ...(patch.effectiveTo !== undefined
        ? { effectiveTo: patch.effectiveTo ?? null }
        : {}),
    })
    .where(eq(claimRecordsTable.id, id))
    .returning();
  return row;
}

export async function submitClaim(
  id: string,
  actorId: string,
): Promise<ClaimRecord> {
  const existing = await getClaim(id);
  if (existing.state !== "draft") {
    throw new DomainError(
      "CLAIM_BAD_STATE",
      `Only draft claims can be submitted for review (state is '${existing.state}')`,
      409,
    );
  }
  const [row] = await getDb()
    .update(claimRecordsTable)
    .set({ state: "review", submittedBy: actorId })
    .where(eq(claimRecordsTable.id, id))
    .returning();
  return row;
}

export type ClaimDecisionAction = "approve" | "reject" | "suspend" | "resume";

export async function decideClaim(
  id: string,
  action: ClaimDecisionAction,
  note: string | null,
  actorId: string,
): Promise<ClaimRecord> {
  const existing = await getClaim(id);

  if (action === "approve" || action === "reject") {
    if (existing.state !== "review") {
      throw new DomainError(
        "CLAIM_BAD_STATE",
        `Only claims in review can be ${action}d (state is '${existing.state}')`,
        409,
      );
    }
    // Maker-checker: the author or submitter of THIS version cannot decide it.
    if (
      action === "approve" &&
      (existing.createdBy === actorId || existing.submittedBy === actorId)
    ) {
      throw new DomainError(
        "CLAIM_SELF_APPROVAL",
        "The author of a claim version cannot approve it. A second operator must review and approve.",
        403,
      );
    }
  }

  if (action === "approve") {
    return getDb().transaction(async (tx) => {
      // Supersede the currently active version of the same logical claim (if
      // any) BEFORE activating this one, so the one-active-per-key DB index
      // never trips.
      const [currentActive] = await tx
        .select()
        .from(claimRecordsTable)
        .where(
          and(
            eq(claimRecordsTable.claimKey, existing.claimKey),
            eq(claimRecordsTable.state, "active"),
          ),
        )
        .limit(1);
      if (currentActive) {
        await tx
          .update(claimRecordsTable)
          .set({ state: "superseded", supersededById: existing.id })
          .where(eq(claimRecordsTable.id, currentActive.id));
      }
      const [row] = await tx
        .update(claimRecordsTable)
        .set({ state: "active", decidedBy: actorId, decisionNote: note })
        .where(eq(claimRecordsTable.id, id))
        .returning();
      return row;
    });
  }

  if (action === "reject") {
    const [row] = await getDb()
      .update(claimRecordsTable)
      .set({ state: "rejected", decidedBy: actorId, decisionNote: note })
      .where(eq(claimRecordsTable.id, id))
      .returning();
    return row;
  }

  if (action === "suspend") {
    if (existing.state !== "active") {
      throw new DomainError(
        "CLAIM_BAD_STATE",
        `Only active claims can be suspended (state is '${existing.state}')`,
        409,
      );
    }
    const [row] = await getDb()
      .update(claimRecordsTable)
      .set({ state: "suspended", decidedBy: actorId, decisionNote: note })
      .where(eq(claimRecordsTable.id, id))
      .returning();
    return row;
  }

  // resume: suspended -> active (DB index still guarantees single-active).
  if (existing.state !== "suspended") {
    throw new DomainError(
      "CLAIM_BAD_STATE",
      `Only suspended claims can be resumed (state is '${existing.state}')`,
      409,
    );
  }
  const [row] = await getDb()
    .update(claimRecordsTable)
    .set({ state: "active", decidedBy: actorId, decisionNote: note })
    .where(eq(claimRecordsTable.id, id))
    .returning();
  return row;
}
