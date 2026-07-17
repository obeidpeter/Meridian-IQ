import { and, desc, eq, inArray, isNotNull, like, notInArray, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  submissionAttemptsTable,
  errorCatalogueTable,
  operatorCasesTable,
  invoicesTable,
} from "@workspace/db";
import { registerSweep } from "../pipeline/pipeline";

// INT-02, second half: "unmapped errors alert operators and enter the
// catalogue within one working day." The catalogue page lists unmapped codes
// passively; this sweep makes the alert active — a new failure code with no
// catalogue entry opens an operator case, so the mapping work enters the same
// queue as everything else the Desk handles.

// Exported for the daily brief, which counts these cases by title prefix —
// one constant so the sweep and the brief can never disagree on the format.
export const UNMAPPED_TITLE_PREFIX = "Unmapped code ";

export async function sweepUnmappedCodes(): Promise<void> {
  // Run inside a bypass transaction (CON-M2). Without an ambient context every
  // getDb() call falls back to the raw pool and autocommits independently, so
  // the dedup SELECT and the INSERT below had no snapshot consistency and no
  // atomicity on a mid-sweep throw. Its sibling sweeps already do this.
  await runInBypassContext(async () => {
    await sweepUnmappedCodesInner();
  });
}

async function sweepUnmappedCodesInner(): Promise<void> {
  const known = getDb()
    .select({ code: errorCatalogueTable.code })
    .from(errorCatalogueTable);
  const unmapped = await getDb()
    .select({
      code: submissionAttemptsTable.errorCode,
      occurrences: sql<number>`count(*)::int`,
    })
    .from(submissionAttemptsTable)
    .where(
      and(
        isNotNull(submissionAttemptsTable.errorCode),
        notInArray(submissionAttemptsTable.errorCode, known),
      ),
    )
    .groupBy(submissionAttemptsTable.errorCode);

  for (const row of unmapped) {
    const code = row.code as string;
    // One live "map this code" case per code; a resolved case re-opens on the
    // next sighting until the code actually enters the catalogue.
    const [existing] = await getDb()
      .select({ id: operatorCasesTable.id })
      .from(operatorCasesTable)
      .where(
        and(
          like(operatorCasesTable.title, `${UNMAPPED_TITLE_PREFIX}${code}%`),
          inArray(operatorCasesTable.status, ["open", "in_progress"]),
        ),
      )
      .limit(1);
    if (existing) continue;

    // Anchor the case to the latest invoice that hit the code so the operator
    // opens with real context (cases are firm-billed, so an anchor is needed).
    const [latest] = await getDb()
      .select({
        invoiceId: submissionAttemptsTable.invoiceId,
        firmId: invoicesTable.firmId,
        supplierPartyId: invoicesTable.supplierPartyId,
      })
      .from(submissionAttemptsTable)
      .innerJoin(
        invoicesTable,
        eq(submissionAttemptsTable.invoiceId, invoicesTable.id),
      )
      .where(eq(submissionAttemptsTable.errorCode, code))
      .orderBy(desc(submissionAttemptsTable.createdAt))
      .limit(1);
    if (!latest) continue;

    await getDb().insert(operatorCasesTable).values({
      firmId: latest.firmId,
      clientPartyId: latest.supplierPartyId,
      invoiceId: latest.invoiceId,
      title: `${UNMAPPED_TITLE_PREFIX}${code}: add a catalogue entry (seen ×${row.occurrences})`,
      errorCode: code,
      priority: "medium",
      status: "open",
    });
  }
}

registerSweep(sweepUnmappedCodes);
