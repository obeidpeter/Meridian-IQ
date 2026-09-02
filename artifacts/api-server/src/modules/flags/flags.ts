import type { RequestHandler } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  getDb,
  featureFlagsTable,
  featureFlagOverridesTable,
  firmsTable,
  type FeatureFlag,
} from "@workspace/db";
import { DomainError } from "../errors";

export const CLERK_ENTITLEMENT_FLAG_KEY = "clerk_ai";
export const CLERK_RUNTIME_FLAG_KEY = "clerk_ai_runtime";

// Feature-flag service (PL-02). A dark feature is unreachable: routes call
// isFeatureEnabled and 404 when off. Per-firm overrides let layer-three surfaces
// activate per client on recorded consent.
export async function isFeatureEnabled(
  key: string,
  firmId?: string | null,
): Promise<boolean> {
  if (firmId) {
    const [override] = await getDb()
      .select({ enabled: featureFlagOverridesTable.enabled })
      .from(featureFlagOverridesTable)
      .where(
        and(
          eq(featureFlagOverridesTable.flagKey, key),
          eq(featureFlagOverridesTable.firmId, firmId),
        ),
      )
      .limit(1);
    if (override) return override.enabled;
  }
  const [flag] = await getDb()
    .select({ enabled: featureFlagsTable.enabled })
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, key))
    .limit(1);
  return flag?.enabled ?? false;
}

// Effective availability composes ordinary rollout state with global safety
// controls. Cross-tenant operators have no firm id, so Clerk availability for
// them is the runtime switch alone; firm principals additionally need their
// platform/per-firm rollout entitlement. No firm override can light the
// runtime switch because it is always read globally.
export async function isEffectiveFeatureEnabled(
  key: string,
  firmId?: string | null,
): Promise<boolean> {
  if (key !== CLERK_ENTITLEMENT_FLAG_KEY) {
    return isFeatureEnabled(key, firmId);
  }
  const runtimeEnabled = await isFeatureEnabled(CLERK_RUNTIME_FLAG_KEY, null);
  if (!runtimeEnabled) return false;
  return firmId ? isFeatureEnabled(key, firmId) : true;
}

// Route-level flag gate (PL-02): while the flag is dark the route is
// unreachable and 404s. Firm-scoped by default (per-firm overrides apply);
// pass { global: true } for routes whose callers carry no firm (e.g. buyer
// principals or public endpoints), so the platform default alone decides.
export function requireFlag(
  key: string,
  opts?: { global?: boolean },
): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const enabled = await isEffectiveFeatureEnabled(
      key,
      opts?.global ? null : req.principal.firmId,
    );
    if (!enabled) {
      res.sendStatus(404);
      return;
    }
    next();
  };
}

export type FlagWithCohort = FeatureFlag & { overrideCount: number };

// Every platform flag with the size of its pilot cohort (R99). Under a firm
// principal's RLS the count covers that firm's own overrides only; the
// operator (bypass) sees the whole cohort.
export async function listFlags(): Promise<FlagWithCohort[]> {
  return getDb()
    .select({
      key: featureFlagsTable.key,
      enabled: featureFlagsTable.enabled,
      releaseTag: featureFlagsTable.releaseTag,
      description: featureFlagsTable.description,
      updatedAt: featureFlagsTable.updatedAt,
      overrideCount: sql<number>`(
        SELECT count(*)::int FROM feature_flag_overrides o
        WHERE o.flag_key = ${featureFlagsTable.key}
      )`,
    })
    .from(featureFlagsTable)
    .orderBy(featureFlagsTable.key);
}

export async function getFlag(key: string): Promise<FeatureFlag> {
  const [flag] = await getDb()
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, key))
    .limit(1);
  if (!flag) {
    throw new DomainError("FLAG_NOT_FOUND", `Unknown feature flag: ${key}`, 404);
  }
  return flag;
}

// Flip a platform flag. A key that was never seeded (dark-by-absence) is a
// 404, never a silent no-op: an operator who flips a flag must know it landed.
export async function setFlag(
  key: string,
  enabled: boolean,
): Promise<{ before: FeatureFlag; after: FeatureFlag }> {
  const before = await getFlag(key);
  const [after] = await getDb()
    .update(featureFlagsTable)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(featureFlagsTable.key, key))
    .returning();
  return { before, after: after ?? { ...before, enabled } };
}

// One member of a flag's pilot cohort, as the cohort page reads it.
export interface FirmOverride {
  flagKey: string;
  firmId: string;
  firmName: string;
  enabled: boolean;
  reason: string | null;
  setByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const overrideColumns = {
  flagKey: featureFlagOverridesTable.flagKey,
  firmId: featureFlagOverridesTable.firmId,
  firmName: firmsTable.name,
  enabled: featureFlagOverridesTable.enabled,
  reason: featureFlagOverridesTable.reason,
  setByUserId: featureFlagOverridesTable.setByUserId,
  createdAt: featureFlagOverridesTable.createdAt,
  updatedAt: featureFlagOverridesTable.updatedAt,
};

// The pilot cohort of one flag (R99): every firm override on it, by firm
// name. Cross-firm by nature — the operator runs in the bypass context; a
// firm principal's RLS narrows it to that firm's own row.
export async function listFirmOverrides(key: string): Promise<FirmOverride[]> {
  await getFlag(key);
  return getDb()
    .select(overrideColumns)
    .from(featureFlagOverridesTable)
    .innerJoin(firmsTable, eq(firmsTable.id, featureFlagOverridesTable.firmId))
    .where(eq(featureFlagOverridesTable.flagKey, key))
    .orderBy(asc(firmsTable.name), asc(featureFlagOverridesTable.firmId));
}

async function readOverride(
  key: string,
  firmId: string,
): Promise<FirmOverride | null> {
  const [row] = await getDb()
    .select(overrideColumns)
    .from(featureFlagOverridesTable)
    .innerJoin(firmsTable, eq(firmsTable.id, featureFlagOverridesTable.firmId))
    .where(
      and(
        eq(featureFlagOverridesTable.flagKey, key),
        eq(featureFlagOverridesTable.firmId, firmId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Set (or re-set) a firm's override with who and why (R99). Returns the
// row as it was and as it is, so the route can put both on the audit chain.
// `who` is optional only for internal seeding (tests, fixtures) — the route
// always supplies the actor and a reason.
export async function setFirmOverride(
  key: string,
  firmId: string,
  enabled: boolean,
  who: { actorId?: string | null; reason?: string | null } = {},
): Promise<{ before: FirmOverride | null; after: FirmOverride }> {
  if (key === CLERK_RUNTIME_FLAG_KEY) {
    throw new DomainError(
      "FLAG_NOT_OVERRIDABLE",
      "The Clerk runtime safety switch is global and cannot be overridden for one firm",
      400,
    );
  }
  await getFlag(key);
  const [firm] = await getDb()
    .select({ id: firmsTable.id })
    .from(firmsTable)
    .where(eq(firmsTable.id, firmId))
    .limit(1);
  if (!firm) {
    throw new DomainError("FIRM_NOT_FOUND", "Unknown firm", 404);
  }
  const before = await readOverride(key, firmId);
  await getDb()
    .insert(featureFlagOverridesTable)
    .values({
      flagKey: key,
      firmId,
      enabled,
      reason: who.reason ?? null,
      setByUserId: who.actorId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        featureFlagOverridesTable.flagKey,
        featureFlagOverridesTable.firmId,
      ],
      set: {
        enabled,
        reason: who.reason ?? null,
        setByUserId: who.actorId ?? null,
        updatedAt: new Date(),
      },
    });
  const after = await readOverride(key, firmId);
  if (!after) {
    throw new DomainError("OVERRIDE_NOT_FOUND", "Override did not persist", 500);
  }
  return { before, after };
}

// Clear a firm's override so the platform default applies again (R99) —
// distinct from an explicit `enabled: false`, which darkens the firm even
// when the platform flag is lit. Returns the row that was cleared, null
// when there was none.
export async function clearFirmOverride(
  key: string,
  firmId: string,
): Promise<FirmOverride | null> {
  const before = await readOverride(key, firmId);
  if (!before) return null;
  await getDb()
    .delete(featureFlagOverridesTable)
    .where(
      and(
        eq(featureFlagOverridesTable.flagKey, key),
        eq(featureFlagOverridesTable.firmId, firmId),
      ),
    );
  return before;
}

// The lit feature keys for a principal's firm: every platform flag row with
// any per-firm override applied on top (an override may light a key whose
// platform row is dark — the pilot-mode mechanism — or darken one). Powers
// Me.features so the apps can hide dark surfaces instead of navigating into
// a 404 (the client half of PL-02). Keys only, sorted; never secrets.
export async function litFeatureKeys(firmId: string | null): Promise<string[]> {
  const flags = await getDb()
    .select({ key: featureFlagsTable.key, enabled: featureFlagsTable.enabled })
    .from(featureFlagsTable);
  const lit = new Map(flags.map((f) => [f.key, f.enabled]));
  if (firmId) {
    const overrides = await getDb()
      .select({
        flagKey: featureFlagOverridesTable.flagKey,
        enabled: featureFlagOverridesTable.enabled,
      })
      .from(featureFlagOverridesTable)
      .where(eq(featureFlagOverridesTable.firmId, firmId));
    for (const o of overrides) lit.set(o.flagKey, o.enabled);
  }
  const runtimeEnabled = lit.get(CLERK_RUNTIME_FLAG_KEY) ?? false;
  lit.set(
    CLERK_ENTITLEMENT_FLAG_KEY,
    runtimeEnabled &&
      (firmId ? (lit.get(CLERK_ENTITLEMENT_FLAG_KEY) ?? false) : true),
  );
  // The runtime key is an operator control, not a client capability. Clients
  // receive only the composite clerk_ai truth and cannot mistake the safety
  // switch for a separately usable product feature.
  lit.delete(CLERK_RUNTIME_FLAG_KEY);
  return [...lit.entries()]
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .sort();
}
