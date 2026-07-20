import { createHash } from "node:crypto";
import {
  GENERIC_CSV_FORMAT_KEY,
  renderGenericStatementCsv,
} from "./parsers.ts";

// Bank-feed connector contract (Wave C) — the open-banking seam the parser
// abstraction (parsers.ts) always promised, built on the ERP connector
// template (modules/connectors/contract.ts): one interface over N feed
// backends — authentication plus incremental pull with an opaque cursor — and
// a registry the sync engine resolves keys through, never branches on.
//
// THE ONE INVARIANT: pulled lines must flow INTO ingestStatement
// (service.ts), never into bank_statement_lines directly. A feed sync renders
// its pull to CSV (renderFeedCsv below) and commits it through the ordinary
// ingest path, so the CORE-03 "reconciliation" consent gate, the parser's
// normalization invariants, the statement/line storage shape and the
// statement.reconcile outbox enqueue all apply to feed-sourced lines exactly
// as they do to a hand-uploaded export. A connector that bypassed ingest
// would silently skip the consent check — never do it.

// One pulled transaction line, already normalized by the connector (feeds are
// APIs, not CSV exports, so the connector owns normalization — the shape
// mirrors parsers.ts's ParsedStatementLine minus the parse bookkeeping).
export interface StatementFeedLine {
  valueDate: string; // ISO yyyy-mm-dd
  amount: string; // absolute amount, "12345.67"
  direction: "credit" | "debit";
  narration: string;
  reference?: string | null;
}

export interface FeedPullResult {
  lines: StatementFeedLine[];
  // Opaque resume point after these lines; null = nothing new was pulled and
  // the stored cursor must stay unchanged.
  nextCursor: string | null;
}

export interface StatementFeedConnector {
  key: string;
  name: string;
  description: string;
  // Validate the connection's auth configuration.
  authenticate(
    config: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }>;
  // Incremental pull from an opaque cursor (null = from the beginning).
  pullLines(
    config: Record<string, unknown>,
    cursor: string | null,
    limit: number,
  ): Promise<FeedPullResult>;
}

// The format the rendered CSV targets. generic_csv is the built-in fallback
// parser (parsers.ts): a plain Date/Narration/Reference/Amount/Direction
// header with CR/DR markers is the simplest shape that round-trips loss-free
// through parseStatementText — no bank-specific quirks, single amount column,
// explicit direction. The engine passes this key explicitly so detection can
// never drift to another parser.
export const FEED_FORMAT_KEY = GENERIC_CSV_FORMAT_KEY;

// Render pulled lines to the generic_csv shape ingestStatement parses — the
// ONE renderer that lives next to the parser it inverts (parsers.ts; the
// scanned-statement surface uses the same one). The round-trip is exact:
// every rendered line parses (feed.test.ts proves it), so a committed feed
// statement always reports parsedCount === lineCount.
export function renderFeedCsv(lines: StatementFeedLine[]): string {
  return renderGenericStatementCsv(lines);
}

// ---- simulated connector -----------------------------------------------------
// Same posture as the ERP connectors (implementations.ts): no real bank API is
// reachable from this environment, so the first connector is a deterministic
// simulated backend that exercises the full contract — auth, cursor resume,
// stable line content — so tests and the demo behave identically run to run.

function det(seed: string, i: number, mod: number): number {
  const h = createHash("sha256").update(`${seed}:${i}`).digest();
  return h.readUInt32BE(0) % mod;
}

function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

const PAYER_POOL = [
  "ZENITH RETAIL GROUP",
  "SAHARA LOGISTICS LTD",
  "EKO DISTRIBUTION CO",
  "AREWA AGRO LTD",
];

// Each simulated account holds a fixed book of transactions; pulls page
// through it incrementally and a drained book yields empty pulls thereafter.
const BOOK_SIZE = 18;

export const demobankConnector: StatementFeedConnector = {
  key: "demobank",
  name: "DemoBank Open Banking",
  description:
    "Incremental transaction feed from DemoBank (simulated sandbox backend).",
  async authenticate(config) {
    const key = String(config.apiKey ?? "");
    if (!key.startsWith("demo_")) {
      return { ok: false, error: "DemoBank apiKey must start with demo_" };
    }
    return { ok: true };
  },
  async pullLines(config, cursor, limit): Promise<FeedPullResult> {
    const seed = `demobank:${String(config.account ?? "default")}`;
    const start = parseCursor(cursor);
    const end = Math.min(start + limit, BOOK_SIZE);
    if (end <= start) return { lines: [], nextCursor: null };
    const lines: StatementFeedLine[] = [];
    for (let i = start; i < end; i++) {
      // Spread value dates over Q1 2027, deterministically per (account, i).
      const day = det(seed, i * 7 + 1, 90);
      const valueDate = new Date(Date.UTC(2027, 0, 1 + day))
        .toISOString()
        .slice(0, 10);
      const payer = PAYER_POOL[det(seed, i, PAYER_POOL.length)];
      const credit = det(seed, i * 11, 5) !== 0; // ~4 in 5 lines are credits
      const amount = (50_000 + det(seed, i * 5, 200) * 250).toFixed(2);
      lines.push({
        valueDate,
        amount,
        direction: credit ? "credit" : "debit",
        narration: credit
          ? `NIP transfer from ${payer} ref DMB-${1000 + i}`
          : `Card purchase POS-${7000 + i}`,
        reference: `DMB-${1000 + i}`,
      });
    }
    return { lines, nextCursor: String(end) };
  },
};

export const STATEMENT_FEED_CONNECTORS: Record<string, StatementFeedConnector> =
  {
    [demobankConnector.key]: demobankConnector,
  };

export function findFeedConnector(key: string): StatementFeedConnector | null {
  return STATEMENT_FEED_CONNECTORS[key] ?? null;
}
