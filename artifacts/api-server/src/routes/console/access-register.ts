import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  clientAssignmentsTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import {
  GetAccessRegisterResponse,
  AttestAccessRegisterBody,
  AttestAccessRegisterResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import { sendCsvAttachment, toCsv } from "../../lib/csv";
import { assertCan, firmScope } from "../../modules/auth/rbac";
import { appendAudit } from "../../modules/audit/audit";
import { DomainError } from "../../modules/errors";

// Lightweight access review (architecture.md D14): reporting and attestation
// only. The register is computed from what already exists — memberships,
// the auth.login audit trail, TOTP state, client assignments — and a firm
// admin attests it as reviewed against its hash, on the audit chain. No
// identity-provider dependency, no new credential surface.

const ATTEST_ACTION = "access.review.attested";

interface RegisterMember {
  userId: string;
  fullName: string | null;
  email: string | null;
  role: string;
  clientPartyId: string | null;
  since: Date;
  lastSignInAt: Date | null;
  mfaEnabled: boolean;
  assignedClients: string[];
}

// The hash covers who holds what — identity, role, scope, MFA, assignments —
// and deliberately NOT last sign-in, which moves on every login and would
// make a freshly attested register stale within the hour.
function registerHash(members: RegisterMember[]): string {
  const canon = members
    .map((m) => ({
      userId: m.userId,
      role: m.role,
      clientPartyId: m.clientPartyId,
      mfaEnabled: m.mfaEnabled,
      assignedClients: [...m.assignedClients].sort(),
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

export async function buildAccessRegister(firmId: string) {
  const db = getDb();
  const rows = await db
    .select({
      userId: usersTable.id,
      fullName: usersTable.fullName,
      email: usersTable.email,
      role: membershipsTable.role,
      clientPartyId: membershipsTable.clientPartyId,
      since: membershipsTable.createdAt,
      totpEnabledAt: usersTable.totpEnabledAt,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .where(eq(membershipsTable.firmId, firmId))
    .orderBy(asc(membershipsTable.createdAt), asc(usersTable.id));
  const userIds = rows.map((r) => r.userId);

  const lastSignIn = new Map<string, Date>();
  if (userIds.length > 0) {
    const logins = await db
      .select({
        actorId: auditEventsTable.actorId,
        at: sql<Date>`max(${auditEventsTable.createdAt})`,
      })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, "auth.login"),
          inArray(auditEventsTable.actorId, userIds),
        ),
      )
      .groupBy(auditEventsTable.actorId);
    for (const l of logins) {
      if (l.actorId) lastSignIn.set(l.actorId, new Date(l.at));
    }
  }

  const assigned = new Map<string, string[]>();
  const assignments = await db
    .select({
      userId: clientAssignmentsTable.userId,
      legalName: partiesTable.legalName,
    })
    .from(clientAssignmentsTable)
    .innerJoin(
      partiesTable,
      eq(partiesTable.id, clientAssignmentsTable.clientPartyId),
    )
    .where(eq(clientAssignmentsTable.firmId, firmId));
  for (const a of assignments) {
    const list = assigned.get(a.userId) ?? [];
    list.push(a.legalName);
    assigned.set(a.userId, list);
  }

  const members: RegisterMember[] = rows.map((r) => ({
    userId: r.userId,
    fullName: r.fullName,
    email: r.email,
    role: r.role,
    clientPartyId: r.clientPartyId,
    since: r.since,
    lastSignInAt: lastSignIn.get(r.userId) ?? null,
    mfaEnabled: r.totpEnabledAt !== null,
    assignedClients: (assigned.get(r.userId) ?? []).sort(),
  }));

  const [last] = await db
    .select({
      actorId: auditEventsTable.actorId,
      createdAt: auditEventsTable.createdAt,
      after: auditEventsTable.after,
    })
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.firmId, firmId),
        eq(auditEventsTable.action, ATTEST_ACTION),
      ),
    )
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(1);
  const lastAfter = (last?.after ?? {}) as {
    hash?: string;
    memberCount?: number;
    byName?: string | null;
  };

  return {
    firmId,
    generatedAt: new Date(),
    hash: registerHash(members),
    members,
    lastAttestation: last
      ? {
          attestedAt: last.createdAt,
          byUserId: last.actorId ?? "",
          byName: lastAfter.byName ?? null,
          memberCount: lastAfter.memberCount ?? 0,
          hash: lastAfter.hash ?? "",
        }
      : null,
  };
}

const router: IRouter = Router();

router.get("/console/access-register", async (req, res): Promise<void> => {
  assertCan(req.principal, "access.review");
  const firmId = firmScope(req.principal);
  res.json(GetAccessRegisterResponse.parse(await buildAccessRegister(firmId)));
});

router.get(
  "/console/access-register/csv",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "access.review");
    const firmId = firmScope(req.principal);
    const register = await buildAccessRegister(firmId);
    const csv = toCsv(
      [
        "user_id",
        "full_name",
        "email",
        "role",
        "client_party_id",
        "since",
        "last_sign_in_at",
        "mfa_enabled",
        "assigned_clients",
      ],
      register.members.map((m) => [
        m.userId,
        m.fullName ?? "",
        m.email ?? "",
        m.role,
        m.clientPartyId ?? "",
        m.since.toISOString(),
        m.lastSignInAt ? m.lastSignInAt.toISOString() : "",
        m.mfaEnabled ? "yes" : "no",
        m.assignedClients.join("; "),
      ]),
    );
    sendCsvAttachment(res, `access-register-${firmId}.csv`, csv);
  },
);

// Attest the register as reviewed. The caller names the hash they reviewed;
// if the register moved since (a member joined, a role changed, an
// assignment shifted), the attestation is refused rather than vouching for
// a state nobody looked at.
router.post(
  "/console/access-register/attest",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "access.review");
    const body = parseOrThrow(AttestAccessRegisterBody, req.body);
    const firmId = firmScope(req.principal);
    const register = await buildAccessRegister(firmId);
    if (body.hash !== register.hash) {
      throw new DomainError(
        "REGISTER_STALE",
        "The access register changed since you reviewed it — review the current register and attest again",
        409,
      );
    }
    const me = register.members.find((m) => m.userId === req.principal.userId);
    const byName = me?.fullName ?? me?.email ?? null;
    const event = await appendAudit({
      actorId: req.principal.userId,
      actorRole: req.principal.role,
      firmId,
      action: ATTEST_ACTION,
      entityType: "access_register",
      entityId: firmId,
      after: {
        hash: register.hash,
        memberCount: register.members.length,
        byName,
      },
    });
    res.status(201).json(
      AttestAccessRegisterResponse.parse({
        attestedAt: event.createdAt,
        byUserId: req.principal.userId,
        byName,
        memberCount: register.members.length,
        hash: register.hash,
      }),
    );
  },
);

export default router;
