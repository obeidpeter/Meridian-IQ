import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  invoicesTable,
  partiesTable,
  type ClerkExtraction,
  type Party,
  type PreflightIssue,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { firmPartySphereCondition } from "../party/party";

// Register-history pre-flight (exhaust idea #6). The pure pre-flight checks
// internal consistency; the firm's own register and invoice history can catch
// what internal consistency cannot — a confident extraction whose TIN
// disagrees with the registered TIN for that customer, a TIN that belongs to
// a DIFFERENT party than the name suggests, or a VAT treatment this supplier
// has never used before. All checks are deterministic SQL and token
// containment; no model is involved, and the issues merge into the same
// preflight list the console already renders.
//
// The posture, stated once:
//  - Candidates come from the FIRM'S PARTY SPHERE only
//    (firmPartySphereCondition — the parties table is the shared spine with
//    no tenant RLS), invoice history is firm-filtered, and issue messages
//    reference the DOCUMENT's own values; register TINs appear masked.
//  - Name evidence must be STRONG (at least two meaningful matching tokens)
//    and UNAMBIGUOUS (all strong matches agree on the TIN) before the
//    register may complain — a false warning trains operators to ignore the
//    check.
//  - The missing-TIN reminder is ADVISORY: it renders at review but does not
//    knock a case out of the ready-to-approve fast lane, because "the
//    document does not print a TIN the register knows" is the common case
//    for well-behaved firms, not a defect.
//  - Reads run in an explicit bypass scope (capture paths execute outside
//    request contexts) with the firm filters enforced here; best-effort — a
//    register hiccup yields no issues, never a blocked extraction.

// Effective VAT-rate deviation (in rate points) that counts as unusual.
const VAT_DEVIATION = 0.02;
// History smaller than this proves nothing about a supplier's habits.
const VAT_MIN_SAMPLES = 5;
// Only statuses that represent real, live commercial documents inform the
// supplier's "usual rate" — failed and cancelled papers do not.
const HISTORY_STATUSES = [
  "validated",
  "submitted",
  "stamped",
  "confirmed",
  "settled",
] as const;

function normalizeTin(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function maskTin(tin: string): string {
  const n = normalizeTin(tin);
  return n.length <= 3 ? "…" : `…${n.slice(-3)}`;
}

// Mirrors party-match.ts / exemplar.ts: legal-form suffixes carry no identity.
const GENERIC_TOKENS = new Set([
  "LTD",
  "LIMITED",
  "PLC",
  "CO",
  "COMPANY",
  "ENTERPRISES",
  "ENTERPRISE",
  "VENTURES",
  "AND",
  "THE",
  "OF",
]);

function meaningfulTokens(name: string): Set<string> {
  return new Set(
    name
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t)),
  );
}

// Strong name evidence: at least two meaningful tokens shared between the
// extracted name and the register name. A single shared token ("Adaeze")
// would let any register party sharing it trigger false TIN warnings.
export function strongNameMatch(
  extracted: string | null,
  partyName: string,
): boolean {
  if (!extracted) return false;
  const a = meaningfulTokens(extracted);
  if (a.size < 2) return false;
  const b = meaningfulTokens(partyName);
  let hits = 0;
  for (const t of a) if (b.has(t)) hits += 1;
  return hits >= 2;
}

// Amounts come back as printed — "1,250,000.00" included (same dialect rule
// as preflight.ts).
function num(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fieldValue(
  extraction: ClerkExtraction,
  field: string,
): string | null {
  const v = extraction.fields.find((f) => f.field === field)?.value ?? null;
  return v !== null && v.trim() === "" ? null : v;
}

type SphereParty = Pick<Party, "id" | "legalName" | "tin" | "type">;

// One identity's register checks: TIN-vs-register for a strong, unambiguous
// name match; an advisory missing-TIN reminder; and
// TIN-belongs-to-someone-else crossover.
export function identityIssues(
  role: "supplier" | "buyer",
  extracted: { name: string | null; tin: string | null },
  candidates: SphereParty[],
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const tinField = role === "supplier" ? "supplierTin" : "buyerTin";
  const who = role === "supplier" ? "this supplier" : "this customer";

  const strong = candidates.filter((c) =>
    strongNameMatch(extracted.name, c.legalName),
  );
  // Ambiguous evidence (several strong matches naming different TINs) says
  // nothing trustworthy — stay silent rather than cite the wrong party.
  const tins = new Set(
    strong.map((c) => normalizeTin(c.tin)).filter((t) => t.length > 0),
  );
  const byName = strong.length > 0 && tins.size <= 1 ? strong[0] : null;

  const extractedTin = normalizeTin(extracted.tin);
  if (byName?.tin) {
    const registered = normalizeTin(byName.tin);
    if (extractedTin && registered && extractedTin !== registered) {
      issues.push({
        field: tinField,
        message: `The ${role} TIN read from the document does not match the registered TIN for ${who} (register ends ${maskTin(byName.tin)})`,
      });
    } else if (!extractedTin && registered) {
      issues.push({
        field: tinField,
        severity: "advisory",
        message: `No ${role} TIN was read, but ${who} has a TIN on the register — confirm it at approval`,
      });
    }
  }

  // Crossover: the extracted TIN exists on the register under a DIFFERENT
  // party than the (single, unambiguous) name evidence points at.
  if (extractedTin.length >= 6 && byName) {
    const tinOwner = candidates.find(
      (c) => normalizeTin(c.tin) === extractedTin,
    );
    if (tinOwner && tinOwner.id !== byName.id) {
      issues.push({
        field: tinField,
        message: `The ${role} TIN read from the document is registered to a different party than the ${role} name suggests`,
      });
    }
  }
  return issues;
}

export async function registerPreflightChecks(
  extraction: ClerkExtraction,
  firmId: string | null,
): Promise<PreflightIssue[]> {
  // Operator captures have no firm, hence no sphere to check against.
  if (!firmId) return [];
  try {
    const sphere = firmPartySphereCondition(firmId);
    const candidates = await runInBypassContext(() =>
      getDb()
        .select({
          id: partiesTable.id,
          legalName: partiesTable.legalName,
          tin: partiesTable.tin,
          type: partiesTable.type,
        })
        .from(partiesTable)
        .where(
          and(
            isNull(partiesTable.mergedIntoId),
            inArray(partiesTable.type, ["client_business", "buyer"]),
            sphere,
          ),
        ),
    );

    const issues: PreflightIssue[] = [
      ...identityIssues(
        "supplier",
        {
          name: fieldValue(extraction, "supplierName"),
          tin: fieldValue(extraction, "supplierTin"),
        },
        candidates.filter((c) => c.type === "client_business"),
      ),
      ...identityIssues(
        "buyer",
        {
          name: fieldValue(extraction, "buyerName"),
          tin: fieldValue(extraction, "buyerTin"),
        },
        candidates,
      ),
    ];

    issues.push(...(await vatHistoryIssues(extraction, firmId, candidates)));
    return issues;
  } catch (err) {
    logger.warn({ err, firmId }, "register preflight failed; skipping checks");
    return [];
  }
}

// Unusual VAT treatment: the document's effective rate (vatTotal/subtotal)
// deviates from what this supplier's own live invoice history consistently
// shows.
async function vatHistoryIssues(
  extraction: ClerkExtraction,
  firmId: string,
  candidates: SphereParty[],
): Promise<PreflightIssue[]> {
  const subtotal = num(fieldValue(extraction, "subtotal"));
  const vatTotal = num(fieldValue(extraction, "vatTotal"));
  if (subtotal === null || subtotal <= 0 || vatTotal === null) return [];
  const docRate = vatTotal / subtotal;

  const supplierName = fieldValue(extraction, "supplierName");
  const supplierTin = normalizeTin(fieldValue(extraction, "supplierTin"));
  const suppliers = candidates.filter((c) => c.type === "client_business");
  const supplier =
    suppliers.find(
      (c) => supplierTin.length >= 6 && normalizeTin(c.tin) === supplierTin,
    ) ?? suppliers.find((c) => strongNameMatch(supplierName, c.legalName));
  if (!supplier) return [];

  const rows = (
    await runInBypassContext(() =>
      getDb().execute<{ n: number; median: string | null }>(sql`
        SELECT COUNT(*)::int AS n,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY ${invoicesTable.vatTotal}::numeric / ${invoicesTable.subtotal}::numeric
          ) AS median
        FROM ${invoicesTable}
        WHERE ${and(
          eq(invoicesTable.firmId, firmId),
          eq(invoicesTable.supplierPartyId, supplier.id),
          eq(invoicesTable.kind, "invoice"),
          inArray(invoicesTable.status, [...HISTORY_STATUSES]),
          sql`${invoicesTable.subtotal}::numeric > 0`,
        )}
      `),
    )
  ).rows;
  const n = Number(rows[0]?.n ?? 0);
  const median = rows[0]?.median != null ? Number(rows[0].median) : null;
  if (n < VAT_MIN_SAMPLES || median === null || !Number.isFinite(median)) {
    return [];
  }
  if (Math.abs(docRate - median) <= VAT_DEVIATION) return [];
  return [
    {
      field: "vatTotal",
      message: `VAT works out to ${(docRate * 100).toFixed(1)}% of the subtotal, but this supplier's invoices are usually ${(median * 100).toFixed(1)}% — confirm the rate`,
    },
  ];
}
