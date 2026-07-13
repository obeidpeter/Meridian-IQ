import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  featureFlagsTable,
  featureFlagOverridesTable,
  type FeatureFlag,
} from "@workspace/db";

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

// Route-level flag gate (PL-02): while the flag is dark the route is
// unreachable and 404s. Firm-scoped by default (per-firm overrides apply);
// pass { global: true } for routes whose callers carry no firm (e.g. buyer
// principals or public endpoints), so the platform default alone decides.
export function requireFlag(
  key: string,
  opts?: { global?: boolean },
): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const enabled = await isFeatureEnabled(
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
  return getDb().select().from(featureFlagsTable).orderBy(featureFlagsTable.key);
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
