import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  staffNotificationPreferencesTable,
  type StaffNotificationPreferencesRow,
} from "@workspace/db";
import {
  GetStaffNotificationPreferencesResponse,
  UpdateStaffNotificationPreferencesBody,
  UpdateStaffNotificationPreferencesResponse,
  ConfirmStaffEmailBody,
  ConfirmStaffEmailResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { isUuid } from "../lib/uuid";
import { appendAudit } from "../modules/audit/audit";
import {
  clearActionFailures,
  isActionThrottled,
  recordActionFailure,
} from "../modules/auth/throttle";
import { requireFirmScope, type Principal } from "../modules/auth/rbac";
import { relayConfigured, sendRawToRelay } from "../modules/messaging/messaging";
import { DomainError } from "../modules/errors";

// Staff notification preferences (self-service, OPT-IN). A firm member
// manages their OWN row — the userId always comes from the principal, never
// from input — so the capability matrix is deliberately not the tool here: a
// matrix capability describes what a role may do to the firm's DATA, while
// this route only ever touches the caller's personal settings. The explicit
// role check below is the whole gate: firm_admin and firm_staff are the two
// roles the weekly digest addresses (client_users have the client-facing
// alert-preference rail; platform roles have no firm digest), and
// requireFirmScope pins the row to the caller's tenant. Everything defaults
// OFF — a member who never opts in receives nothing (which is also why
// delivery needs no consent gate; see modules/clerk/digest.ts).
//
// Preferences are PER CURRENT-FIRM CONTEXT: the row key is (userId, firmId)
// — both from the principal — so a multi-firm staff member holds an
// independent row per firm, matching the table's firm-keyed RLS (migration
// 0019). The contract shape is unchanged; the firm is implied by the
// caller's tenant, never named in the payload.
//
// The `email` field is a free-text address the member typed in, and the
// digest email channel only fires once it is VERIFIED (emailVerifiedAt set
// by the confirm-email flow below): an attacker with a stolen staff session
// must not be able to point a firm's digest notifications at an arbitrary
// inbox. Changing or clearing the address clears the verification — a new
// address always starts unverified.

const router: IRouter = Router();

const DEFAULTS = {
  digestEnabled: false,
  emailEnabled: false,
  pushEnabled: false,
  email: null as string | null,
};

// Verification codes: 6 digits, sha256-only stored, short-lived.
const VERIFY_CODE_TTL_MS = 15 * 60 * 1000;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Constant-time hex-digest comparison (both operands are sha256 hex, so the
// lengths always match; a length mismatch still returns false, never throws).
function digestEquals(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function prefsBody(row: StaffNotificationPreferencesRow | undefined) {
  return {
    digestEnabled: row?.digestEnabled ?? DEFAULTS.digestEnabled,
    emailEnabled: row?.emailEnabled ?? DEFAULTS.emailEnabled,
    pushEnabled: row?.pushEnabled ?? DEFAULTS.pushEnabled,
    email: row?.email ?? DEFAULTS.email,
    emailVerifiedAt: row?.emailVerifiedAt?.toISOString() ?? null,
  };
}

// Self-service gate: firm members only, bound to their firm. Returns the
// caller's firmId.
function staffSelfScope(principal: Principal): string {
  if (principal.role !== "firm_admin" && principal.role !== "firm_staff") {
    throw new DomainError(
      "FORBIDDEN",
      "Notification preferences are a firm-staff surface",
      403,
    );
  }
  return requireFirmScope(principal);
}

async function ownRow(
  userId: string,
  firmId: string,
): Promise<StaffNotificationPreferencesRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(staffNotificationPreferencesTable)
    .where(
      and(
        eq(staffNotificationPreferencesTable.userId, userId),
        eq(staffNotificationPreferencesTable.firmId, firmId),
      ),
    )
    .limit(1);
  return row;
}

router.get("/staff/notification-preferences", async (req, res): Promise<void> => {
  const firmId = staffSelfScope(req.principal);
  // The dev x-mock shim can carry a non-UUID userId ("dev-user"); such a
  // principal can own no row, so it reads the all-off defaults. The firm
  // filter keeps a multi-firm member's firms independent (composite key).
  const row = isUuid(req.principal.userId)
    ? await ownRow(req.principal.userId, firmId)
    : undefined;
  res.json(GetStaffNotificationPreferencesResponse.parse(prefsBody(row)));
});

router.put("/staff/notification-preferences", async (req, res): Promise<void> => {
  const firmId = staffSelfScope(req.principal);
  const parsed = parseOrThrow(UpdateStaffNotificationPreferencesBody, req.body);
  if (!isUuid(req.principal.userId)) {
    res.status(400).json({
      error: "Notification preferences require a real user session",
    });
    return;
  }

  // Partial input merges onto the existing row for THIS firm (or the all-off
  // defaults): omitted switches keep their value; email distinguishes
  // omitted (undefined — keep) from explicit null (clear).
  const existing = await ownRow(req.principal.userId, firmId);
  const next = {
    digestEnabled:
      parsed.digestEnabled ??
      existing?.digestEnabled ??
      DEFAULTS.digestEnabled,
    emailEnabled:
      parsed.emailEnabled ?? existing?.emailEnabled ?? DEFAULTS.emailEnabled,
    pushEnabled:
      parsed.pushEnabled ?? existing?.pushEnabled ?? DEFAULTS.pushEnabled,
    email:
      parsed.email !== undefined
        ? (parsed.email ?? null)
        : (existing?.email ?? DEFAULTS.email),
  };

  // CHANGING the address (including clearing it) drops the verification and
  // any pending code: verification attests to one exact address, never the
  // next one. Re-saving the identical string keeps the verified state.
  const emailChanged = next.email !== (existing?.email ?? null);
  const verificationReset = emailChanged
    ? {
        emailVerifiedAt: null,
        emailVerifyCodeHash: null,
        emailVerifyExpiresAt: null,
      }
    : {};

  const [row] = await getDb()
    .insert(staffNotificationPreferencesTable)
    .values({ userId: req.principal.userId, firmId, ...next })
    .onConflictDoUpdate({
      // Composite key (userId, firmId), both from the principal: a
      // multi-firm member saves each firm's preferences independently —
      // never re-homing (or clobbering) another firm's row.
      target: [
        staffNotificationPreferencesTable.userId,
        staffNotificationPreferencesTable.firmId,
      ],
      set: { ...next, ...verificationReset, updatedAt: new Date() },
    })
    .returning();
  res.json(UpdateStaffNotificationPreferencesResponse.parse(prefsBody(row)));
});

// Dispatch a 6-digit verification code to the SAVED address. Only the code's
// sha256 + a 15-minute expiry are stored; requests are throttled per user
// (the same raw-pool counters as the credential checks, so the cap survives
// any rollback) because every request can cost a relay send.
router.post(
  "/staff/notification-preferences/request-email-verification",
  async (req, res): Promise<void> => {
    const firmId = staffSelfScope(req.principal);
    if (!isUuid(req.principal.userId)) {
      res.status(400).json({
        error: "Email verification requires a real user session",
      });
      return;
    }
    const throttleKey = `everify:${req.principal.userId}`;
    const retryAfter = await isActionThrottled(throttleKey);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      });
      return;
    }

    const row = await ownRow(req.principal.userId, firmId);
    if (!row?.email) {
      res.status(400).json({ error: "Save an email address first" });
      return;
    }
    // Every request counts against the cap (this throttles SENDS, not
    // failures — there is no failure signal to count instead).
    await recordActionFailure(throttleKey);

    // The outbound relay is the messaging transport's webhook
    // (relayConfigured lives with the transport that reads the same env).
    // When it is not configured the platform has no way to reach any inbox:
    // respond 202 and send nothing — the response is deliberately identical
    // to the dispatched case so this endpoint is not a relay-configuration
    // oracle.
    if (!relayConfigured()) {
      res.status(202).end();
      return;
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await getDb()
      .update(staffNotificationPreferencesTable)
      .set({
        emailVerifyCodeHash: sha256Hex(code),
        emailVerifyExpiresAt: new Date(Date.now() + VERIFY_CODE_TTL_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(staffNotificationPreferencesTable.userId, req.principal.userId),
          eq(staffNotificationPreferencesTable.firmId, firmId),
        ),
      );

    // DELIBERATE, DOCUMENTED SEC-12 EXCEPTION: the platform's messaging seam
    // is pointer-only — sendMessage rejects anything that looks like a raw
    // address, and the RELAY owns ref→address resolution on its side of the
    // wire. Verification is the one flow that cannot ride a pointer: its
    // entire purpose is to prove ownership of an address the platform has not
    // yet blessed, so no ref→address mapping exists for the relay to resolve.
    // The raw {email, code} therefore crosses to the SAME relay endpoint
    // through sendRawToRelay — the exception's one home in
    // modules/messaging/messaging.ts (same URL, same x-op-token secret, same
    // 5s abort ceiling), the address-handling boundary SEC-12 already trusts
    // with every resolved address — under its own kind tag, and to nowhere
    // else. The result is deliberately ignored: dispatch failures look
    // exactly like successes, so the endpoint is no oracle.
    await sendRawToRelay("staff_email_verify", { email: row.email, code });
    res.status(202).end();
  },
);

// Confirm the saved address with the received code. Guesses are throttled on
// their own key (wrong/expired codes count; success clears), the comparison
// is constant-time over sha256 digests, and success stamps emailVerifiedAt
// and burns the code.
router.post(
  "/staff/notification-preferences/confirm-email",
  async (req, res): Promise<void> => {
    const firmId = staffSelfScope(req.principal);
    const parsed = parseOrThrow(ConfirmStaffEmailBody, req.body);
    if (!isUuid(req.principal.userId)) {
      res.status(400).json({
        error: "Email verification requires a real user session",
      });
      return;
    }
    const throttleKey = `everifyc:${req.principal.userId}`;
    const retryAfter = await isActionThrottled(throttleKey);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      });
      return;
    }

    const row = await ownRow(req.principal.userId, firmId);
    const presentedHash = sha256Hex(parsed.code);
    const valid =
      row?.emailVerifyCodeHash != null &&
      row.emailVerifyExpiresAt != null &&
      row.emailVerifyExpiresAt.getTime() > Date.now() &&
      digestEquals(presentedHash, row.emailVerifyCodeHash);
    if (!valid) {
      // Raw-pool counter: survives this 400's transaction rollback.
      await recordActionFailure(throttleKey);
      res.status(400).json({ error: "Invalid or expired code" });
      return;
    }

    // Compare-and-set on the STORED code hash, not just (userId, firmId): a
    // concurrent PUT can swap the address (clearing hash + verification)
    // between the read above and this write — a bare-key UPDATE would then
    // stamp emailVerifiedAt onto the NEW, unverified address. The hash
    // predicate makes the stamp land only on the exact pending-code state the
    // presented code proved; zero rows means the state moved underneath us
    // and the confirm fails like any other invalid code.
    const now = new Date();
    const [updated] = await getDb()
      .update(staffNotificationPreferencesTable)
      .set({
        emailVerifiedAt: now,
        emailVerifyCodeHash: null,
        emailVerifyExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(staffNotificationPreferencesTable.userId, req.principal.userId),
          eq(staffNotificationPreferencesTable.firmId, firmId),
          eq(staffNotificationPreferencesTable.emailVerifyCodeHash, presentedHash),
        ),
      )
      .returning();
    if (!updated) {
      await recordActionFailure(throttleKey);
      res.status(400).json({ error: "Invalid or expired code" });
      return;
    }
    await clearActionFailures(throttleKey);
    // Pointer-only audit: the verified ADDRESS never enters the audit trail.
    await appendAudit({
      actorId: req.principal.userId,
      firmId,
      action: "staff.email.verified",
      entityType: "staff_notification_preferences",
      entityId: req.principal.userId,
      after: { verified: true },
    });
    res.json(ConfirmStaffEmailResponse.parse(prefsBody(updated)));
  },
);

export default router;
