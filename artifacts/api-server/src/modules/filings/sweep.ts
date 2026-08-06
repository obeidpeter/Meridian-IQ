// Filing mint sweep: keeps every firm's statutory returns register current
// without anyone clicking sync — each pass mints the last closed Lagos
// period's rows for every firm with a live engagement. Cheap when current
// (one distinct scan plus per-firm inserts that all hit the natural-key
// conflict), and safe to race: the advisory lock only dedupes work on ONE
// instance's pass — cross-instance idempotency rests entirely on the unique
// (firm, client, tax, period) index inside mintFilingsForFirm.
import { sql } from "drizzle-orm";
import { getDb, runInBypassContext, engagementsTable } from "@workspace/db";
import { mintFilingsForFirm } from "./filings";

// Fresh advisory lock id (731_842..846 are taken by the clerk watch sweeps).
const FILING_MINT_LOCK_ID = 731_847;

// Sweep-only: must run OUTSIDE any request context. Candidate enumeration is
// a SHORT bypass transaction under a try-lock (the client-statement sweep's
// shape — a concurrent pass skips instead of piling up); the per-firm mint
// loop runs after it so no long transaction spans every firm's inserts.
export async function sweepFilingMint(
  now = new Date(),
): Promise<{ firms: number; minted: number }> {
  const firmIds = await runInBypassContext(async () => {
    const [{ locked }] = (
      await getDb().execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${FILING_MINT_LOCK_ID}) AS locked`,
      )
    ).rows;
    if (!locked) return [];
    // A register is owed to every firm that actively serves at least one
    // client (open/in_progress engagements — the same live-engagement wall
    // mintFilingsForFirm applies per client).
    const rows = await getDb()
      .selectDistinct({ firmId: engagementsTable.firmId })
      .from(engagementsTable)
      .where(sql`${engagementsTable.status} IN ('open', 'in_progress')`);
    return rows.map((r) => r.firmId);
  });
  let minted = 0;
  for (const firmId of firmIds) {
    minted += await runInBypassContext(() => mintFilingsForFirm(firmId, now));
  }
  return { firms: firmIds.length, minted };
}
