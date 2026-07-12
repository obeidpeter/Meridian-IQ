import { and, desc, eq, sql } from "drizzle-orm";
import {
  getDb,
  claimRecordsTable,
  type ClaimRecordRow,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";

// Claims register (CLK-KB-01..08). The control promise of the whole Clerk
// feature lives here: binding compliance facts are deterministic. A claim is a
// counsel-approved proposition whose protected values (amounts, rates, dates,
// thresholds, citations) are stored separately from language and inserted into
// any rendering by THIS code — never by a model (CLK-KB-04, CLK-AI-03).

export interface ClaimActor {
  userId: string;
  role: string;
}

export interface ClaimDraftInput {
  claimKey: string;
  jurisdiction?: string;
  taxpayerClasses?: string[];
  transactionClasses?: string[];
  proposition: string;
  legalInstrument: string;
  legalSection: string;
  protectedFacts?: ClaimRecordRow["protectedFacts"];
  sourceEvidenceRef?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  reviewDueAt: string;
  clerkQuotable?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Placeholders in a proposition must resolve to protected facts and vice
// versa — a fact the language never renders is dead weight, and a placeholder
// without a fact would render as a literal "{gap}" a user could mistake for
// an approved value.
function assertFactsMatchProposition(
  proposition: string,
  facts: ClaimRecordRow["protectedFacts"],
): void {
  const placeholders = new Set(
    [...proposition.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)].map((m) => m[1]),
  );
  const factKeys = new Set(facts.map((f) => f.key));
  for (const p of placeholders) {
    if (!factKeys.has(p)) {
      throw new DomainError(
        "CLAIM_INVALID",
        `Proposition references {${p}} but no protected fact defines it`,
        400,
      );
    }
  }
  for (const k of factKeys) {
    if (!placeholders.has(k)) {
      throw new DomainError(
        "CLAIM_INVALID",
        `Protected fact "${k}" is never rendered by the proposition`,
        400,
      );
    }
  }
}

export async function createClaimDraft(
  input: ClaimDraftInput,
  actor: ClaimActor,
): Promise<ClaimRecordRow> {
  if (!DATE_RE.test(input.effectiveFrom) || !DATE_RE.test(input.reviewDueAt)) {
    throw new DomainError(
      "CLAIM_INVALID",
      "effectiveFrom and reviewDueAt must be YYYY-MM-DD dates",
      400,
    );
  }
  if (input.effectiveTo && !DATE_RE.test(input.effectiveTo)) {
    throw new DomainError(
      "CLAIM_INVALID",
      "effectiveTo must be a YYYY-MM-DD date",
      400,
    );
  }
  const facts = input.protectedFacts ?? [];
  assertFactsMatchProposition(input.proposition, facts);

  // Version-chain: a new draft for an existing key becomes the next version
  // and records lineage to the currently active version (CLK-KB-02: versioned
  // and never silently overwritten).
  const [latest] = await getDb()
    .select({
      version: claimRecordsTable.version,
      id: claimRecordsTable.id,
      status: claimRecordsTable.status,
    })
    .from(claimRecordsTable)
    .where(eq(claimRecordsTable.claimKey, input.claimKey))
    .orderBy(desc(claimRecordsTable.version))
    .limit(1);
  const [active] = await getDb()
    .select({ id: claimRecordsTable.id })
    .from(claimRecordsTable)
    .where(
      and(
        eq(claimRecordsTable.claimKey, input.claimKey),
        eq(claimRecordsTable.status, "active"),
      ),
    )
    .limit(1);

  const [row] = await getDb()
    .insert(claimRecordsTable)
    .values({
      claimKey: input.claimKey,
      version: (latest?.version ?? 0) + 1,
      status: "draft",
      jurisdiction: input.jurisdiction ?? "NG",
      taxpayerClasses: input.taxpayerClasses ?? [],
      transactionClasses: input.transactionClasses ?? [],
      proposition: input.proposition,
      legalInstrument: input.legalInstrument,
      legalSection: input.legalSection,
      protectedFacts: facts,
      sourceEvidenceRef: input.sourceEvidenceRef ?? null,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      reviewDueAt: input.reviewDueAt,
      clerkQuotable: input.clerkQuotable ?? false,
      authorId: actor.userId,
      supersedesId: active?.id ?? null,
    })
    .returning();
  await appendAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: "clerk.claim.drafted",
    entityType: "claim_record",
    entityId: row.id,
    after: { claimKey: row.claimKey, version: row.version },
  });
  return row;
}

async function loadClaim(id: string): Promise<ClaimRecordRow> {
  const [row] = await getDb()
    .select()
    .from(claimRecordsTable)
    .where(eq(claimRecordsTable.id, id))
    .limit(1);
  if (!row) throw new DomainError("NOT_FOUND", "Claim record not found", 404);
  return row;
}

// Compare-and-set state transition so two concurrent approvals (or an approve
// racing a suspend) cannot both win.
async function transitionClaim(
  id: string,
  from: ClaimRecordRow["status"][],
  to: ClaimRecordRow["status"],
  patch: Partial<typeof claimRecordsTable.$inferInsert> = {},
): Promise<ClaimRecordRow> {
  const rows = await getDb()
    .update(claimRecordsTable)
    .set({ status: to, ...patch })
    .where(
      and(
        eq(claimRecordsTable.id, id),
        sql`${claimRecordsTable.status} IN (${sql.join(
          from.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      ),
    )
    .returning();
  if (rows.length === 0) {
    throw new DomainError(
      "CLAIM_STATE_CONFLICT",
      `Claim is not in a state that allows the ${to} transition`,
      409,
    );
  }
  return rows[0];
}

export async function submitClaimForReview(
  id: string,
  actor: ClaimActor,
): Promise<ClaimRecordRow> {
  const row = await transitionClaim(id, ["draft"], "review");
  await appendAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: "clerk.claim.submitted",
    entityType: "claim_record",
    entityId: row.id,
  });
  return row;
}

export async function approveClaim(
  id: string,
  actor: ClaimActor,
  approvalEvidence?: string,
): Promise<ClaimRecordRow> {
  const claim = await loadClaim(id);
  // Maker-checker (CLK-KB-03): the author can never approve their own version.
  if (claim.authorId === actor.userId) {
    throw new DomainError(
      "MAKER_CHECKER",
      "The author of a claim version cannot approve it",
      409,
    );
  }
  return getDb().transaction(async (tx) => {
    // Serialize per claimKey so two approvals can't produce two actives.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"claim:" + claim.claimKey}))`,
    );
    // Supersede the current active version of this key, if any.
    await tx
      .update(claimRecordsTable)
      .set({ status: "superseded" })
      .where(
        and(
          eq(claimRecordsTable.claimKey, claim.claimKey),
          eq(claimRecordsTable.status, "active"),
        ),
      );
    const rows = await tx
      .update(claimRecordsTable)
      .set({
        status: "active",
        approverId: actor.userId,
        approvalEvidence: approvalEvidence ?? null,
      })
      .where(
        and(
          eq(claimRecordsTable.id, id),
          eq(claimRecordsTable.status, "review"),
        ),
      )
      .returning();
    if (rows.length === 0) {
      throw new DomainError(
        "CLAIM_STATE_CONFLICT",
        "Claim is not in review",
        409,
      );
    }
    await appendAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      action: "clerk.claim.approved",
      entityType: "claim_record",
      entityId: id,
      after: { claimKey: claim.claimKey, version: claim.version },
    });
    return rows[0];
  });
}

export async function rejectClaim(
  id: string,
  actor: ClaimActor,
  reason: string,
): Promise<ClaimRecordRow> {
  const claim = await loadClaim(id);
  if (claim.authorId === actor.userId) {
    throw new DomainError(
      "MAKER_CHECKER",
      "The author of a claim version cannot decide on it",
      409,
    );
  }
  const row = await transitionClaim(id, ["review"], "rejected", {
    approverId: actor.userId,
    approvalEvidence: `rejected: ${reason}`,
  });
  await appendAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: "clerk.claim.rejected",
    entityType: "claim_record",
    entityId: id,
    after: { reason },
  });
  return row;
}

// Emergency withdrawal (CLK-KB-06): blocks new runtime use immediately.
export async function suspendClaim(
  id: string,
  actor: ClaimActor,
  reason: string,
): Promise<ClaimRecordRow> {
  const row = await transitionClaim(id, ["active"], "suspended", {
    approvalEvidence: `suspended: ${reason}`,
  });
  await appendAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: "clerk.claim.suspended",
    entityType: "claim_record",
    entityId: id,
    after: { reason },
  });
  return row;
}

export async function listClaims(filter: {
  status?: string;
  claimKey?: string;
}): Promise<ClaimRecordRow[]> {
  const conditions = [];
  if (filter.status) {
    conditions.push(
      eq(
        claimRecordsTable.status,
        filter.status as ClaimRecordRow["status"],
      ),
    );
  }
  if (filter.claimKey) {
    conditions.push(eq(claimRecordsTable.claimKey, filter.claimKey));
  }
  const base = getDb().select().from(claimRecordsTable);
  const rows = conditions.length
    ? await base.where(and(...conditions)).orderBy(
        desc(claimRecordsTable.createdAt),
      )
    : await base.orderBy(desc(claimRecordsTable.createdAt));
  return rows;
}

// ---------------------------------------------------------------------------
// Runtime retrieval + deterministic rendering (CLK-AI-03/04, CLK-KB-07)
// ---------------------------------------------------------------------------

export type ClaimLookup =
  | { ok: true; claim: ClaimRecordRow }
  | {
      ok: false;
      reason: "not_found" | "not_effective" | "overdue_review";
    };

// The only claim a runtime answer may use: the single active version of the
// key, inside its effective window, with its review not overdue. Anything
// else is a refusal, not an answer (CLK-AI-04; CLK-KB-07: expired or overdue
// records cannot answer).
export async function getAnswerableClaim(
  claimKey: string,
  onDate = new Date().toISOString().slice(0, 10),
): Promise<ClaimLookup> {
  const [claim] = await getDb()
    .select()
    .from(claimRecordsTable)
    .where(
      and(
        eq(claimRecordsTable.claimKey, claimKey),
        eq(claimRecordsTable.status, "active"),
      ),
    )
    .limit(1);
  if (!claim) return { ok: false, reason: "not_found" };
  if (
    claim.effectiveFrom > onDate ||
    (claim.effectiveTo !== null && claim.effectiveTo < onDate)
  ) {
    return { ok: false, reason: "not_effective" };
  }
  if (claim.reviewDueAt < onDate) {
    return { ok: false, reason: "overdue_review" };
  }
  return { ok: true, claim };
}

function formatFact(fact: ClaimRecordRow["protectedFacts"][number]): string {
  if (fact.kind === "amount") {
    const n = Number(fact.value);
    const formatted = Number.isFinite(n)
      ? n.toLocaleString("en-NG")
      : fact.value;
    // Currency-style unit leads: "NGN 50,000".
    return fact.unit ? `${fact.unit} ${formatted}` : formatted;
  }
  if (fact.kind === "threshold") {
    const n = Number(fact.value);
    const formatted = Number.isFinite(n)
      ? n.toLocaleString("en-NG")
      : fact.value;
    // Measurement-style unit trails: "24 hour".
    return fact.unit ? `${formatted} ${fact.unit}` : formatted;
  }
  if (fact.kind === "rate") {
    return fact.unit ? `${fact.value}${fact.unit}` : `${fact.value}%`;
  }
  return fact.value;
}

export interface RenderedClaim {
  answer: string;
  citation: string;
  protectedFacts: ClaimRecordRow["protectedFacts"];
  claimKey: string;
  claimVersion: number;
}

// Deterministic protected-fact assembly (CLK-AI-03): pure string substitution
// from the record — no model in the path, so the rendered values can never
// diverge from the approved ones. Tests assert exact equality.
export function renderClaim(claim: ClaimRecordRow): RenderedClaim {
  let answer = claim.proposition;
  for (const fact of claim.protectedFacts) {
    answer = answer.split(`{${fact.key}}`).join(formatFact(fact));
  }
  return {
    answer,
    citation: `${claim.legalInstrument}, ${claim.legalSection}`,
    protectedFacts: claim.protectedFacts,
    claimKey: claim.claimKey,
    claimVersion: claim.version,
  };
}
