import { randomBytes } from "node:crypto";
import { and, eq, lt, ne, or } from "drizzle-orm";
import {
  getDb,
  passwordResetsTable,
  runInBypassContext,
  usersTable,
} from "@workspace/db";
import { DomainError } from "../errors";
import { hashPassword, normalizeEmail } from "./session";
import { hashInviteToken } from "./invitations";
import { appendAudit } from "../audit/audit";
import { registerSweep } from "../pipeline/pipeline";
import type { Principal } from "./rbac";

// Password recovery (IDN-02), on the invitation rail's posture.
//
// There is no self-serve "forgot password" email loop yet (message delivery
// ships dark), so recovery is operator-assisted: an operator issues a
// single-use reset link for the user — 32 random bytes shown once, only the
// sha256 stored — and shares it out-of-band, exactly like an invite. Redeeming
// is public (the token IS the credential): it sets the new password, bumps the
// user's session epoch so every outstanding session token dies (SEC-02), and
// consumes the reset via a compare-and-set on status so a token cannot be
// redeemed twice even under a race. Both sides are audited.

const RESET_TTL_MS = 24 * 60 * 60 * 1000;

function resetView(row: {
  id: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}) {
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export interface CreatePasswordResetResult {
  reset: ReturnType<typeof resetView> & { email: string };
  token: string;
}

export async function createPasswordReset(
  principal: Principal,
  emailInput: string,
): Promise<CreatePasswordResetResult> {
  const email = normalizeEmail(emailInput);
  const [user] = await getDb()
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  // The route sits behind identity.write (operators), who can already
  // enumerate users via identity.read — a plain 404 is fine here.
  if (!user) {
    throw new DomainError("USER_NOT_FOUND", "No account with that email", 404);
  }

  // Issuing a new reset supersedes any still-pending one for the same user, so
  // exactly one live link exists per account at a time.
  await getDb()
    .update(passwordResetsTable)
    .set({ status: "revoked" })
    .where(
      and(
        eq(passwordResetsTable.userId, user.id),
        eq(passwordResetsTable.status, "pending"),
      ),
    );

  const token = randomBytes(32).toString("hex");
  const [row] = await getDb()
    .insert(passwordResetsTable)
    .values({
      userId: user.id,
      tokenHash: hashInviteToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
      issuedByUserId: principal.userId,
    })
    .returning();
  await appendAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    action: "password_reset.issue",
    entityType: "password_reset",
    entityId: row.id,
    after: { userId: user.id, email: user.email },
  });
  return { reset: { ...resetView(row), email: user.email }, token };
}

export async function resetPassword(
  token: string,
  password: string,
): Promise<void> {
  const tokenHash = hashInviteToken(token);
  const [reset] = await getDb()
    .select()
    .from(passwordResetsTable)
    .where(eq(passwordResetsTable.tokenHash, tokenHash))
    .limit(1);
  // Uniform message for not-found / used / revoked / expired: never disclose
  // which resets exist or why a token is unusable.
  const invalid = () =>
    new DomainError("INVALID_RESET", "Invalid or expired reset link", 400);
  if (!reset || reset.status !== "pending") throw invalid();
  if (reset.expiresAt.getTime() <= Date.now()) throw invalid();

  // Claim first (compare-and-set): a concurrent redeem flips the status and
  // the loser bails before touching the password.
  const claimed = await getDb()
    .update(passwordResetsTable)
    .set({ status: "used", usedAt: new Date() })
    .where(
      and(
        eq(passwordResetsTable.id, reset.id),
        eq(passwordResetsTable.status, "pending"),
      ),
    )
    .returning({ id: passwordResetsTable.id });
  if (claimed.length === 0) throw invalid();

  // Set the new password and bump the session epoch: every previously-issued
  // session token carries the old epoch and stops resolving (SEC-02) — the
  // reset doubles as compromise remediation.
  const [user] = await getDb()
    .select({ sessionEpoch: usersTable.sessionEpoch })
    .from(usersTable)
    .where(eq(usersTable.id, reset.userId))
    .limit(1);
  if (!user) throw invalid();
  await getDb()
    .update(usersTable)
    .set({
      passwordHash: await hashPassword(password),
      sessionEpoch: user.sessionEpoch + 1,
    })
    .where(eq(usersTable.id, reset.userId));

  await appendAudit({
    actorId: reset.userId,
    action: "password_reset.redeem",
    entityType: "password_reset",
    entityId: reset.id,
  });
}

// Retention: reset rows are dead weight once they can never be redeemed —
// used, revoked, or expired — but they stay 30 days as a short forensic
// window (who was issued a link, when it was consumed; the durable trail is
// the audit ledger). Only a still-live pending link survives past the cutoff,
// which cannot actually happen given the 24h TTL — the expiry check is belt
// and braces should the TTL ever grow. The table is bypass-only (migration
// 0012), so the sweep binds its own bypass context like the other sweeps;
// errors propagate to the sweep runner for the OBS-01 error metric.
const RESET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function sweepExpiredPasswordResets(): Promise<void> {
  await runInBypassContext(async () => {
    const cutoff = new Date(Date.now() - RESET_RETENTION_MS);
    await getDb()
      .delete(passwordResetsTable)
      .where(
        and(
          lt(passwordResetsTable.createdAt, cutoff),
          or(
            ne(passwordResetsTable.status, "pending"),
            lt(passwordResetsTable.expiresAt, new Date()),
          ),
        ),
      );
  });
}

registerSweep(sweepExpiredPasswordResets);
