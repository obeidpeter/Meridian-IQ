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
import { lagosDateString } from "../../lib/lagos-time";
import { SUBMISSION_WINDOW_DAYS } from "../invoice/compliance-window";
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
// Amount-outlier bounds (history-based anomaly, exhaust idea #1): a total
// this many times the supplier's median — or that fraction of it — is worth a
// second look. Deliberately wide: invoice sizes legitimately vary a lot, and
// a false warning trains reviewers to ignore the check. Same minimum-history
// rule as the VAT check.
const AMOUNT_OUTLIER_FACTOR = 10;
// A future issue date beyond tomorrow (clock skew allowance) is suspicious.
const FUTURE_DATE_SLACK_DAYS = 1;
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

// Resolve the document's supplier to a register party: an exact TIN match
// outranks strong-name evidence (shared with the VAT and history checks).
function resolveSupplier(
  extraction: ClerkExtraction,
  candidates: SphereParty[],
): SphereParty | null {
  const supplierName = fieldValue(extraction, "supplierName");
  const supplierTin = normalizeTin(fieldValue(extraction, "supplierTin"));
  const suppliers = candidates.filter((c) => c.type === "client_business");
  return (
    suppliers.find(
      (c) => supplierTin.length >= 6 && normalizeTin(c.tin) === supplierTin,
    ) ??
    suppliers.find((c) => strongNameMatch(supplierName, c.legalName)) ??
    null
  );
}

// Issue-date sanity (exhaust idea #1) — pure, no register needed, so it runs
// for operator captures too. Two shapes of trouble: a date so old the invoice
// arrives ALREADY past the statutory submission window (penalty exposure the
// moment it is approved), and a date in the future (usually a misread digit).
// Both advisory: dates on real paper are sometimes genuinely odd, and review
// is where a human confirms them.
export function issueDateIssues(
  extraction: ClerkExtraction,
  today: string = lagosDateString(),
): PreflightIssue[] {
  const raw = fieldValue(extraction, "issueDate");
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return [];
  const issue = new Date(`${raw}T00:00:00Z`);
  const now = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(issue.getTime())) return [];
  const ageDays = Math.round((now.getTime() - issue.getTime()) / 86_400_000);
  if (ageDays >= SUBMISSION_WINDOW_DAYS) {
    return [
      {
        field: "issueDate",
        severity: "advisory",
        message: `The issue date is ${ageDays} days ago — this invoice is already past the ${SUBMISSION_WINDOW_DAYS}-day submission window on arrival. Submit promptly, or confirm the date was read correctly`,
      },
    ];
  }
  if (ageDays < -FUTURE_DATE_SLACK_DAYS) {
    return [
      {
        field: "issueDate",
        severity: "advisory",
        message: `The issue date is in the future (${raw}) — confirm it was read correctly`,
      },
    ];
  }
  return [];
}

export async function registerPreflightChecks(
  extraction: ClerkExtraction,
  firmId: string | null,
  // SEC-03: when the capture is by a client_user, this is that user's OWN
  // party. The history checks below aggregate a matched supplier's invoice
  // ledger into issue TEXT the client can read on its own case — firm-keyed
  // RLS is not a sibling wall, so for a client-scoped capture those checks run
  // ONLY when the matched supplier is the capturing client itself. A
  // firm/operator capture (null here) keeps the full firm-wide view.
  capturingClientPartyId: string | null = null,
): Promise<PreflightIssue[]> {
  // Date sanity needs no register, so operator captures get it too.
  const dateIssues = issueDateIssues(extraction);
  // Operator captures have no firm, hence no sphere to check against.
  if (!firmId) return dateIssues;
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
      ...dateIssues,
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

    issues.push(
      ...(await vatHistoryIssues(
        extraction,
        firmId,
        candidates,
        capturingClientPartyId,
      )),
    );
    issues.push(
      ...(await supplierHistoryIssues(
        extraction,
        firmId,
        candidates,
        capturingClientPartyId,
      )),
    );
    return issues;
  } catch (err) {
    logger.warn({ err, firmId }, "register preflight failed; skipping checks");
    return dateIssues;
  }
}

// Duplicate detection + amount outlier (exhaust idea #1), one SQL round trip
// over the supplier's own invoice history in this firm:
//  - an existing non-cancelled invoice with the SAME number is very likely a
//    duplicate submission — a full (non-advisory) issue, because approving it
//    creates a real compliance mess;
//  - failing that, an invoice with the same issue date AND the same total is
//    a probable duplicate under a different number — advisory;
//  - a total far outside the supplier's usual range (× / ÷ the outlier
//    factor of the median over enough live invoices) is worth a second look —
//    advisory, exactly the OCR-slipped-digit a tired reviewer approves.
async function supplierHistoryIssues(
  extraction: ClerkExtraction,
  firmId: string,
  candidates: SphereParty[],
  capturingClientPartyId: string | null,
): Promise<PreflightIssue[]> {
  const supplier = resolveSupplier(extraction, candidates);
  if (!supplier) return [];
  // SEC-03: a client_user must never learn a sibling client's invoice history
  // through these messages — only run when the matched supplier is its own.
  if (capturingClientPartyId && supplier.id !== capturingClientPartyId) {
    return [];
  }

  const invoiceNumber = fieldValue(extraction, "invoiceNumber")?.trim() ?? "";
  const issueDate = fieldValue(extraction, "issueDate");
  const validDate =
    issueDate && /^\d{4}-\d{2}-\d{2}$/.test(issueDate) ? issueDate : null;
  const grandTotal = num(fieldValue(extraction, "grandTotal"));

  const rows = (
    await runInBypassContext(() =>
      getDb().execute<{
        dup_number: number;
        dup_status: string | null;
        dup_date_total: number;
        n_history: number;
        median_total: string | null;
      }>(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE ${invoiceNumber !== ""}
              AND upper(${invoicesTable.invoiceNumber}) = upper(${invoiceNumber})
          )::int AS dup_number,
          (array_agg(${invoicesTable.status}) FILTER (
            WHERE ${invoiceNumber !== ""}
              AND upper(${invoicesTable.invoiceNumber}) = upper(${invoiceNumber})
          ))[1] AS dup_status,
          COUNT(*) FILTER (
            WHERE ${validDate !== null && grandTotal !== null}
              AND ${invoicesTable.issueDate} = ${validDate ?? "1970-01-01"}::date
              AND ${invoicesTable.grandTotal}::numeric = ${grandTotal ?? 0}::numeric
          )::int AS dup_date_total,
          COUNT(*) FILTER (
            WHERE ${invoicesTable.status} IN ('validated', 'submitted', 'stamped', 'confirmed', 'settled')
          )::int AS n_history,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY ${invoicesTable.grandTotal}::numeric
          ) FILTER (
            WHERE ${invoicesTable.status} IN ('validated', 'submitted', 'stamped', 'confirmed', 'settled')
          ) AS median_total
        FROM ${invoicesTable}
        WHERE ${and(
          eq(invoicesTable.firmId, firmId),
          eq(invoicesTable.supplierPartyId, supplier.id),
          eq(invoicesTable.kind, "invoice"),
          // Cancelled AND credited (credit-note-reversed) are dead paper — a
          // re-issue under the same number is not a duplicate. Mirrors the
          // HISTORY_STATUSES posture and recurring-suggest's exclusion.
          sql`${invoicesTable.status} NOT IN ('cancelled', 'credited')`,
        )}
      `),
    )
  ).rows;
  const r = rows[0];
  if (!r) return [];

  const issues: PreflightIssue[] = [];
  if (Number(r.dup_number) > 0) {
    issues.push({
      field: "invoiceNumber",
      message: `An invoice with this number already exists for this supplier (status: ${r.dup_status ?? "unknown"}) — this looks like a duplicate submission`,
    });
  } else if (Number(r.dup_date_total) > 0) {
    issues.push({
      field: "invoiceNumber",
      severity: "advisory",
      message:
        "An invoice from this supplier with the same issue date and the same total already exists under a different number — check for a duplicate",
    });
  }

  const nHistory = Number(r.n_history ?? 0);
  const median = r.median_total != null ? Number(r.median_total) : null;
  if (
    grandTotal !== null &&
    grandTotal > 0 &&
    nHistory >= VAT_MIN_SAMPLES &&
    median !== null &&
    Number.isFinite(median) &&
    median > 0 &&
    (grandTotal > median * AMOUNT_OUTLIER_FACTOR ||
      grandTotal < median / AMOUNT_OUTLIER_FACTOR)
  ) {
    issues.push({
      field: "grandTotal",
      severity: "advisory",
      message: `The total (NGN ${grandTotal}) is far outside this supplier's usual range (median NGN ${median} over ${nHistory} invoices) — double-check the amount`,
    });
  }
  return issues;
}

// Unusual VAT treatment: the document's effective rate (vatTotal/subtotal)
// deviates from what this supplier's own live invoice history consistently
// shows.
async function vatHistoryIssues(
  extraction: ClerkExtraction,
  firmId: string,
  candidates: SphereParty[],
  capturingClientPartyId: string | null,
): Promise<PreflightIssue[]> {
  const subtotal = num(fieldValue(extraction, "subtotal"));
  const vatTotal = num(fieldValue(extraction, "vatTotal"));
  if (subtotal === null || subtotal <= 0 || vatTotal === null) return [];
  const docRate = vatTotal / subtotal;

  const supplier = resolveSupplier(extraction, candidates);
  if (!supplier) return [];
  // SEC-03: same sibling-isolation rule as supplierHistoryIssues — a
  // client_user only sees its own supplier's rate history.
  if (capturingClientPartyId && supplier.id !== capturingClientPartyId) {
    return [];
  }

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
