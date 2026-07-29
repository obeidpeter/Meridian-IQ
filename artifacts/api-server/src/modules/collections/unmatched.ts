import { inArray, sql } from "drizzle-orm";
import { getDb, collectionAccountsTable, partiesTable } from "@workspace/db";

// Unmatched inbound collections (round-17 idea #3). When a LIVE collection
// account takes a payment the platform cannot bind to an invoice, the
// webhook records a pointer-only `collections.unmatched` audit event (no
// amounts, no payer text — the provider payload is untrusted) and drops the
// payment. That event is the only trace, and today it goes nowhere visible.
// This module reads those events back into a per-account report — the
// collection-rail sibling of the unmatched-credit detector: money arrived,
// nobody knows. Zero model calls, nothing stored, pointer-only throughout
// (counts and timestamps; the amounts were never recorded).

const WINDOW_DAYS = 90;

export const UNMATCHED_COLLECTION_ACTION = "collections.unmatched";

export interface UnmatchedCollectionsReport {
  windowDays: number;
  total: number;
  accounts: {
    accountId: string;
    accountReference: string;
    label: string | null;
    clientPartyId: string;
    clientName: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
  }[];
  note: string;
}

export async function listUnmatchedCollections(
  firmId: string,
): Promise<UnmatchedCollectionsReport> {
  // The total is its own ungrouped count so it stays honest past the
  // per-account LIMIT below and past any account row the join cannot
  // resolve.
  const [totalRow] = (
    await getDb().execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM audit_events e
      WHERE e.action = ${UNMATCHED_COLLECTION_ACTION}
        AND e.firm_id = ${firmId}
        AND e.created_at >= now() - make_interval(days => ${WINDOW_DAYS})
    `)
  ).rows;
  const rows = (
    await getDb().execute<{
      account_id: string;
      count: number;
      first_seen: string;
      last_seen: string;
    }>(sql`
      SELECT e.entity_id AS account_id,
        COUNT(*)::int AS count,
        MIN(e.created_at)::text AS first_seen,
        MAX(e.created_at)::text AS last_seen
      FROM audit_events e
      WHERE e.action = ${UNMATCHED_COLLECTION_ACTION}
        AND e.firm_id = ${firmId}
        AND e.created_at >= now() - make_interval(days => ${WINDOW_DAYS})
      GROUP BY 1
      ORDER BY MAX(e.created_at) DESC
      LIMIT 100
    `)
  ).rows;

  const accountIds = rows.map((r) => r.account_id);
  const accounts = accountIds.length
    ? await getDb()
        .select({
          id: collectionAccountsTable.id,
          accountReference: collectionAccountsTable.accountReference,
          label: collectionAccountsTable.label,
          clientPartyId: collectionAccountsTable.clientPartyId,
          clientName: partiesTable.legalName,
        })
        .from(collectionAccountsTable)
        .innerJoin(
          partiesTable,
          sql`${partiesTable.id} = ${collectionAccountsTable.clientPartyId}`,
        )
        .where(inArray(collectionAccountsTable.id, accountIds))
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const reportRows = rows.flatMap((r) => {
    const account = byId.get(r.account_id);
    // An account row that no longer resolves (deleted client) still counted
    // an unmatched payment — but with nothing to name, the row is dropped
    // from the per-account table while the total stays honest.
    if (!account) return [];
    return [
      {
        accountId: r.account_id,
        accountReference: account.accountReference,
        label: account.label,
        clientPartyId: account.clientPartyId,
        clientName: account.clientName,
        count: Number(r.count),
        firstSeen: new Date(r.first_seen).toISOString(),
        lastSeen: new Date(r.last_seen).toISOString(),
      },
    ];
  });

  return {
    windowDays: WINDOW_DAYS,
    total: Number(totalRow?.n ?? 0),
    accounts: reportRows,
    note:
      `Inbound payments on live collection accounts over the trailing ${WINDOW_DAYS} days that could not be bound to any invoice — ` +
      `the payer quoted no usable invoice number, or the quoted invoice was not in a payable state. ` +
      `Amounts are never recorded for unmatched payments; reconcile against the provider's own statement.`,
  };
}

// Firm-wide count over a short window — the digest/brief fact.
export async function countFirmUnmatchedCollections(
  firmId: string,
  windowDays: number,
): Promise<number> {
  const rows = (
    await getDb().execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM audit_events e
      WHERE e.action = ${UNMATCHED_COLLECTION_ACTION}
        AND e.firm_id = ${firmId}
        AND e.created_at >= now() - make_interval(days => ${windowDays})
    `)
  ).rows;
  return Number(rows[0]?.n ?? 0);
}
