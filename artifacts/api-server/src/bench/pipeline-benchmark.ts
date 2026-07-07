// NFR-03 evidence: the submission pipeline must sustain 50,000 invoice
// submissions per day (~0.58/s) with headroom. This benchmark seeds N
// validated invoices, enqueues their submissions on the transactional outbox,
// drains the worker against the simulated rails, and reports throughput plus
// the extrapolated per-day capacity.
//
// Run: DATABASE_URL=... pnpm --filter @workspace/api-server run benchmark [N]

import { randomUUID } from "node:crypto";
import { getDb, runInBypassContext, requireDatabaseUrl, pool } from "@workspace/db";
import {
  invoicesTable,
  invoiceLinesTable,
  outboxTable,
  partiesTable,
  firmsTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { drain } from "../modules/pipeline/pipeline";

const N = Number(process.argv[2] ?? 2_000);
const TARGET_PER_DAY = 50_000;

async function main(): Promise<void> {
  requireDatabaseUrl();

  const firmId = randomUUID();
  const supplierId = randomUUID();
  const buyerId = randomUUID();

  await runInBypassContext(async () => {
    await getDb().insert(firmsTable).values({ id: firmId, name: `bench-${firmId.slice(0, 8)}` });
    await getDb().insert(partiesTable).values([
      { id: supplierId, type: "client_business", legalName: "Bench Supplier Ltd", tin: `bench-${firmId.slice(0, 8)}-s`, tinValidated: true, street: "1 Bench Road", city: "Lagos" },
      { id: buyerId, type: "buyer", legalName: "Bench Buyer Ltd", tin: `bench-${firmId.slice(0, 8)}-b`, tinValidated: true, street: "2 Bench Road", city: "Lagos" },
    ]);

    console.log(`Seeding ${N} validated invoices...`);
    const CHUNK = 500;
    const invoiceIds: string[] = [];
    for (let i = 0; i < N; i += CHUNK) {
      const size = Math.min(CHUNK, N - i);
      const ids = Array.from({ length: size }, () => randomUUID());
      invoiceIds.push(...ids);
      await getDb().insert(invoicesTable).values(
        ids.map((id, j) => ({
          id,
          firmId,
          supplierPartyId: supplierId,
          buyerPartyId: buyerId,
          invoiceNumber: `BENCH-${i + j}`,
          issueDate: "2027-01-15",
          status: "validated" as const,
          subtotal: "100000.00",
          vatTotal: "7500.00",
          grandTotal: "107500.00",
        })),
      );
      await getDb().insert(invoiceLinesTable).values(
        ids.map((id) => ({
          invoiceId: id,
          lineNo: 1,
          description: "Benchmark line",
          quantity: "1",
          unitPrice: "100000",
          vatRate: "0.075",
          lineExtension: "100000.00",
          vatAmount: "7500.00",
        })),
      );
    }
    // Flip to submitted + enqueue, exactly as submitInvoice does.
    for (let i = 0; i < invoiceIds.length; i += CHUNK) {
      const chunk = invoiceIds.slice(i, i + CHUNK);
      await getDb()
        .update(invoicesTable)
        .set({ status: "submitted" })
        .where(inArray(invoicesTable.id, chunk));
      await getDb().insert(outboxTable).values(
        chunk.map((id) => ({
          aggregateType: "invoice",
          aggregateId: id,
          type: "invoice.submit",
          payload: { invoiceId: id },
        })),
      );
    }
  });

  console.log(`Draining ${N} submissions through the worker + simulated rails...`);
  const started = Date.now();
  let processed = 0;
  while (processed < N) {
    const n = await drain(200);
    if (n === 0) break;
    processed += n;
  }
  const elapsedMs = Date.now() - started;
  const perSecond = processed / (elapsedMs / 1000);
  const perDay = Math.round(perSecond * 86_400);

  const stamped = await runInBypassContext(async () => {
    const rows = await getDb().execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM invoices WHERE firm_id = ${firmId} AND status = 'stamped'`,
    );
    const list = (rows as unknown as { rows?: { count: string }[] }).rows ?? (rows as unknown as { count: string }[]);
    return Number(list[0]?.count ?? 0);
  });

  console.log("");
  console.log(`processed:      ${processed}/${N} outbox events in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`stamped:        ${stamped}`);
  console.log(`throughput:     ${perSecond.toFixed(1)} submissions/s (single worker)`);
  console.log(`extrapolated:   ${perDay.toLocaleString()} submissions/day`);
  console.log(`NFR-03 target:  ${TARGET_PER_DAY.toLocaleString()}/day -> headroom x${(perDay / TARGET_PER_DAY).toFixed(1)}`);
  if (perDay < TARGET_PER_DAY) {
    console.error("FAIL: below the 50k/day envelope");
    process.exitCode = 1;
  } else {
    console.log("PASS: within the NFR-03 envelope");
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
