import { eq } from "drizzle-orm";
import { getDb, settlementEventsTable } from "@workspace/db";
import { decimalToMinorUnits } from "../../lib/money";
import { DomainError } from "../errors";

type SettlementInsert = typeof settlementEventsTable.$inferInsert;

function instant(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function sameNullableDecimal(
  left: string | null,
  right: string | null | undefined,
): boolean {
  if (left === null || right == null) return left === null && right == null;
  return Number(left) === Number(right);
}

function sameOperation(
  existing: typeof settlementEventsTable.$inferSelect,
  requested: SettlementInsert,
  compareOccurredAt: boolean,
): boolean {
  return (
    existing.invoiceId === requested.invoiceId &&
    existing.source === requested.source &&
    decimalToMinorUnits(existing.amount) ===
      decimalToMinorUnits(requested.amount) &&
    sameNullableDecimal(existing.confidence, requested.confidence) &&
    (existing.paymentStatus ?? null) === (requested.paymentStatus ?? null) &&
    (existing.statementLineId ?? null) ===
      (requested.statementLineId ?? null) &&
    (existing.actorId ?? null) === (requested.actorId ?? null) &&
    (!compareOccurredAt ||
      instant(existing.occurredAt) === instant(requested.occurredAt))
  );
}

export async function appendSettlementEvent(
  values: SettlementInsert & { externalReference: string },
  options: { compareOccurredAt?: boolean } = {},
): Promise<{
  event: typeof settlementEventsTable.$inferSelect;
  created: boolean;
}> {
  const [event] = await getDb()
    .insert(settlementEventsTable)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (event) return { event, created: true };

  const [existing] = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(
      eq(settlementEventsTable.externalReference, values.externalReference),
    )
    .limit(1);
  if (!existing) {
    throw new DomainError(
      "SETTLEMENT_CONFLICT",
      "The settlement could not be recorded safely",
      409,
    );
  }
  if (!sameOperation(existing, values, options.compareOccurredAt ?? true)) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for a different settlement",
      409,
    );
  }
  return { event: existing, created: false };
}
