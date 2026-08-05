import { eq } from "drizzle-orm";
import { getDb, featureFlagsTable } from "@workspace/db";
import { setFlag } from "../modules/flags/flags.ts";

// Feature-flag save/set/restore guard for test files (refactor round 7): the
// clerk/test-support.ts save-and-enable idiom, generalized over the flag key
// so the messaging suites stop hand-rolling the same dance. Module state is
// per-file because node:test runs one process per file; a suite makes one
// guard per flag it flips: saveAndSet in before(), restore in after() —
// restore deletes the flag when it did not pre-exist, else sets it back to
// the saved value.
export interface FlagGuard {
  saveAndSet(enabled: boolean): Promise<void>;
  restore(): Promise<void>;
}

export function makeFlagGuard(key: string): FlagGuard {
  let saved: boolean | null = null;
  return {
    async saveAndSet(enabled: boolean): Promise<void> {
      const db = getDb();
      const [existing] = await db
        .select()
        .from(featureFlagsTable)
        .where(eq(featureFlagsTable.key, key))
        .limit(1);
      saved = existing ? existing.enabled : null;
      await db
        .insert(featureFlagsTable)
        .values({ key, enabled, description: "test" })
        .onConflictDoUpdate({
          target: featureFlagsTable.key,
          set: { enabled },
        });
    },
    async restore(): Promise<void> {
      if (saved === null) {
        await getDb()
          .delete(featureFlagsTable)
          .where(eq(featureFlagsTable.key, key));
      } else {
        await setFlag(key, saved);
      }
    },
  };
}
