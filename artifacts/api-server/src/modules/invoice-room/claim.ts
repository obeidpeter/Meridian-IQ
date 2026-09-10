import { eq } from "drizzle-orm";
import {
  getDb,
  membershipsTable,
  runInBypassContext,
  usersTable,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import {
  hashPassword,
  issueSessionToken,
  normalizeEmail,
} from "../auth/session";
import { DomainError } from "../errors";
import { digestRoomSecret } from "./security";
import { loadRoomAccess, appendRoomEvent } from "./core";

// Claiming a Buyer Rails account from a verified Invoice Room email (R109:
// split out of service.ts).

export async function claimInvoiceRoomAccount(
  sessionToken: string,
  input: { fullName?: string | null; password?: string | null },
): Promise<{
  created: boolean;
  loginRequired: boolean;
  buyerPath: string;
  sessionToken?: string;
}> {
  const identity = await runInBypassContext(async () => {
    const access = await loadRoomAccess(sessionToken, {
      requireVerified: true,
    });
    if (access.session.otpChannel !== "email" || !access.share.recipientEmail) {
      throw new DomainError(
        "VERIFIED_EMAIL_REQUIRED",
        "Verify the email address on this invoice link before creating an account",
        400,
      );
    }
    const email = normalizeEmail(access.share.recipientEmail);
    const [existing] = await getDb()
      .select({ id: usersTable.id, sessionEpoch: usersTable.sessionEpoch })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    return { access, email, existing };
  });
  if (!identity.existing && (!input.password || input.password.length < 12)) {
    throw new DomainError(
      "PASSWORD_REQUIRED",
      "Create a password with at least 12 characters",
      400,
    );
  }
  const passwordHash = identity.existing
    ? null
    : await hashPassword(input.password!);
  const result = await runInBypassContext(async () => {
    const access = await loadRoomAccess(sessionToken, {
      requireVerified: true,
    });
    const [current] = await getDb()
      .select({ id: usersTable.id, sessionEpoch: usersTable.sessionEpoch })
      .from(usersTable)
      .where(eq(usersTable.email, identity.email))
      .limit(1);
    let user = current;
    let created = false;
    if (!user) {
      const [inserted] = await getDb()
        .insert(usersTable)
        .values({
          email: identity.email,
          fullName: input.fullName?.trim() || null,
          passwordHash,
        })
        .onConflictDoNothing({ target: usersTable.email })
        .returning({
          id: usersTable.id,
          sessionEpoch: usersTable.sessionEpoch,
        });
      user = inserted;
      created = Boolean(inserted);
      if (!user) {
        const [winner] = await getDb()
          .select({ id: usersTable.id, sessionEpoch: usersTable.sessionEpoch })
          .from(usersTable)
          .where(eq(usersTable.email, identity.email))
          .limit(1);
        user = winner;
      }
    }
    if (!user)
      throw new DomainError(
        "ACCOUNT_CLAIM_FAILED",
        "Account could not be created",
        409,
      );
    await getDb()
      .insert(membershipsTable)
      .values({
        userId: user.id,
        firmId: null,
        role: "buyer_user",
        clientPartyId: null,
        buyerPartyId: access.invoice.buyerPartyId,
      })
      .onConflictDoNothing();
    await appendRoomEvent({
      share: access.share,
      kind: "claimed",
      actorType: "buyer_user",
      actorRef: digestRoomSecret(user.id).slice(0, 24),
      detail: { created },
      idempotencyKey: `claimed:${user.id}`,
    });
    await appendAudit({
      actorId: user.id,
      actorRole: "buyer_user",
      firmId: access.invoice.firmId,
      action: "invoice_room.account_claimed",
      entityType: "invoice_room",
      entityId: access.share.id,
      after: { buyerPartyId: access.invoice.buyerPartyId, created },
    });
    return { user, created };
  });
  return {
    created: result.created,
    loginRequired: !result.created,
    buyerPath: "/buyer/",
    ...(result.created
      ? {
          sessionToken: await issueSessionToken(
            result.user.id,
            result.user.sessionEpoch,
          ),
        }
      : {}),
  };
}
