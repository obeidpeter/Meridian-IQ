import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  featureFlagsTable,
  featureFlagOverridesTable,
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

export async function listFlags(): Promise<FeatureFlag[]> {
  return getDb()
    .select()
    .from(featureFlagsTable)
    .orderBy(featureFlagsTable.key);
}

export async function setFlag(key: string, enabled: boolean): Promise<void> {
  await getDb()
    .update(featureFlagsTable)
    .set({ enabled })
    .where(eq(featureFlagsTable.key, key));
}

export async function setFirmOverride(
  key: string,
  firmId: string,
  enabled: boolean,
): Promise<void> {
  if (key === CLERK_RUNTIME_FLAG_KEY) {
    throw new DomainError(
      "FLAG_NOT_OVERRIDABLE",
      "The Clerk runtime safety switch is global and cannot be overridden for one firm",
      400,
    );
  }
  await getDb()
    .insert(featureFlagOverridesTable)
    .values({ flagKey: key, firmId, enabled })
    .onConflictDoUpdate({
      target: [
        featureFlagOverridesTable.flagKey,
        featureFlagOverridesTable.firmId,
      ],
      set: { enabled },
    });
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
