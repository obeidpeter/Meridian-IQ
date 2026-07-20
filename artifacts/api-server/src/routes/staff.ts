import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { getDb, staffNotificationPreferencesTable } from "@workspace/db";
import {
  GetStaffNotificationPreferencesResponse,
  UpdateStaffNotificationPreferencesBody,
  UpdateStaffNotificationPreferencesResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { isUuid } from "../lib/uuid";
import { requireFirmScope, type Principal } from "../modules/auth/rbac";
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
// WARNING: the `email` field is a free-text, unverified address. It only
// gates whether the email channel fires; delivery itself is pointer-only
// (usr/dig refs, SEC-12) and never uses this address as a destination. It
// must NEVER become a send destination without a verification step (see the
// schema comment in lib/db/src/schema/organizations.ts).

const router: IRouter = Router();

const DEFAULTS = {
  digestEnabled: false,
  emailEnabled: false,
  pushEnabled: false,
  email: null as string | null,
};

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

router.get("/staff/notification-preferences", async (req, res): Promise<void> => {
  const firmId = staffSelfScope(req.principal);
  // The dev x-mock shim can carry a non-UUID userId ("dev-user"); such a
  // principal can own no row, so it reads the all-off defaults. The firm
  // filter keeps a multi-firm member's firms independent (composite key).
  const [row] = isUuid(req.principal.userId)
    ? await getDb()
        .select()
        .from(staffNotificationPreferencesTable)
        .where(
          and(
            eq(staffNotificationPreferencesTable.userId, req.principal.userId),
            eq(staffNotificationPreferencesTable.firmId, firmId),
          ),
        )
        .limit(1)
    : [];
  res.json(
    GetStaffNotificationPreferencesResponse.parse({
      digestEnabled: row?.digestEnabled ?? DEFAULTS.digestEnabled,
      emailEnabled: row?.emailEnabled ?? DEFAULTS.emailEnabled,
      pushEnabled: row?.pushEnabled ?? DEFAULTS.pushEnabled,
      email: row?.email ?? DEFAULTS.email,
    }),
  );
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
  const [existing] = await getDb()
    .select()
    .from(staffNotificationPreferencesTable)
    .where(
      and(
        eq(staffNotificationPreferencesTable.userId, req.principal.userId),
        eq(staffNotificationPreferencesTable.firmId, firmId),
      ),
    )
    .limit(1);
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
      set: { ...next, updatedAt: new Date() },
    })
    .returning();
  res.json(
    UpdateStaffNotificationPreferencesResponse.parse({
      digestEnabled: row.digestEnabled,
      emailEnabled: row.emailEnabled,
      pushEnabled: row.pushEnabled,
      email: row.email,
    }),
  );
});

export default router;
