import { eq } from "drizzle-orm";
import {
  getDb,
  statementFormatMappingsTable,
  type StatementColumnMapping,
  type StatementFormatMapping,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import {
  findParser,
  parseCsvHeadersOnly,
  parserFromMapping,
  type ParsedStatement,
} from "./parsers";

// Custom statement formats (Clerk idea #9). The parser SEAM stays exactly as
// designed — pure column-location specs feeding the shared parse pipeline —
// but the specs can now come from the database as operator-managed platform
// reference data (like the error catalogue), so meeting a new bank's export
// no longer requires a deploy. Saving a mapping REQUIRES a validation run
// against real sample lines: a mapping that cannot parse its own sample is
// rejected, so a wrong proposal (Clerk's or a human's) can never be stored.

export const CUSTOM_KEY_PREFIX = "custom_";
const MAX_SAMPLE_CHARS = 100_000;

export interface MappingValidation {
  headerFound: boolean;
  lineCount: number;
  parsedCount: number;
  parseRate: number;
  // First few lines' outcomes so a human can eyeball what the mapping did.
  preview: {
    lineNo: number;
    parseStatus: "parsed" | "invalid";
    valueDate: string | null;
    amount: string | null;
    direction: "credit" | "debit" | null;
    error: string | null;
  }[];
}

// Run a candidate mapping over sample CSV — the checker for every save and
// for Clerk's proposals. Pure parse, no I/O.
export function validateMapping(
  columns: StatementColumnMapping,
  sampleCsv: string,
): MappingValidation {
  const parser = parserFromMapping({
    key: "candidate",
    bankName: "candidate",
    columns,
  });
  const parsed: ParsedStatement = parser.parse(sampleCsv);
  const headerFound = parsed.lineCount > 0 || detectHeader(parser, sampleCsv);
  return {
    headerFound,
    lineCount: parsed.lineCount,
    parsedCount: parsed.parsedCount,
    parseRate:
      parsed.lineCount === 0
        ? 0
        : Math.round((parsed.parsedCount / parsed.lineCount) * 10000) / 10000,
    preview: parsed.lines.slice(0, 5).map((l) => ({
      lineNo: l.lineNo,
      parseStatus: l.parseStatus,
      valueDate: l.valueDate,
      amount: l.amount,
      direction: l.direction,
      error: l.parseError,
    })),
  };
}

function detectHeader(
  parser: ReturnType<typeof parserFromMapping>,
  sampleCsv: string,
): boolean {
  return parseCsvHeadersOnly(sampleCsv).some((row) => parser.detect(row));
}

function slugify(bankName: string): string {
  return (
    CUSTOM_KEY_PREFIX +
    bankName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40)
  );
}

export interface SaveMappingInput {
  key?: string | null;
  bankName: string;
  columns: StatementColumnMapping;
  sampleCsv: string;
}

// Operator save path: validation is not optional. The sample must locate a
// header row and parse at least one line, or the mapping is rejected.
export async function saveFormatMapping(
  input: SaveMappingInput,
  actorId: string,
): Promise<{ mapping: StatementFormatMapping; validation: MappingValidation }> {
  if (input.sampleCsv.length > MAX_SAMPLE_CHARS) {
    throw new DomainError(
      "SAMPLE_TOO_LARGE",
      "Validate the mapping with a smaller sample (a few dozen lines is plenty).",
      413,
    );
  }
  const validation = validateMapping(input.columns, input.sampleCsv);
  if (!validation.headerFound || validation.parsedCount === 0) {
    throw new DomainError(
      "MAPPING_INVALID",
      "The mapping could not parse the sample: check the column names against the export's header row.",
      422,
    );
  }
  const key = input.key?.trim() || slugify(input.bankName);
  if (!key.startsWith(CUSTOM_KEY_PREFIX)) {
    throw new DomainError(
      "KEY_NOT_NAMESPACED",
      `Custom format keys must start with "${CUSTOM_KEY_PREFIX}".`,
      422,
    );
  }
  // Built-in parser keys are code; a custom mapping may never shadow one.
  if (findParser(key)) {
    throw new DomainError(
      "KEY_RESERVED",
      "That key belongs to a built-in bank format.",
      409,
    );
  }
  const [mapping] = await getDb()
    .insert(statementFormatMappingsTable)
    .values({
      key,
      bankName: input.bankName.trim(),
      columns: input.columns,
      createdBy: actorId,
    })
    .onConflictDoNothing({ target: statementFormatMappingsTable.key })
    .returning();
  if (!mapping) {
    throw new DomainError(
      "KEY_EXISTS",
      "A custom format with that key already exists.",
      409,
    );
  }
  await appendAudit({
    actorId,
    action: "statement_format.create",
    entityType: "statement_format_mapping",
    entityId: mapping.id,
    after: { key, bankName: mapping.bankName, columns: input.columns },
  });
  return { mapping, validation };
}

export async function deleteFormatMapping(
  id: string,
  actorId: string,
): Promise<void> {
  const [removed] = await getDb()
    .delete(statementFormatMappingsTable)
    .where(eq(statementFormatMappingsTable.id, id))
    .returning();
  if (!removed) throw new DomainError("NOT_FOUND", "Format not found", 404);
  await appendAudit({
    actorId,
    action: "statement_format.delete",
    entityType: "statement_format_mapping",
    entityId: id,
    after: { key: removed.key },
  });
}

export async function listFormatMappings(): Promise<StatementFormatMapping[]> {
  return getDb()
    .select()
    .from(statementFormatMappingsTable)
    .orderBy(statementFormatMappingsTable.createdAt);
}

// Ingestion fallback: when no built-in parser recognises the export (or the
// caller names a custom key), try the stored mappings. Same detect-then-parse
// contract as parseStatementText.
export async function parseWithCustomFormats(
  text: string,
  formatKey?: string | null,
): Promise<ParsedStatement | null> {
  if (formatKey) {
    if (!formatKey.startsWith(CUSTOM_KEY_PREFIX)) return null;
    const [row] = await getDb()
      .select()
      .from(statementFormatMappingsTable)
      .where(eq(statementFormatMappingsTable.key, formatKey))
      .limit(1);
    return row ? parserFromMapping(row).parse(text) : null;
  }
  const rows = await listFormatMappings();
  if (rows.length === 0) return null;
  const headerRows = parseCsvHeadersOnly(text);
  for (const row of rows) {
    const parser = parserFromMapping(row);
    if (headerRows.some((h) => parser.detect(h))) {
      return parser.parse(text);
    }
  }
  return null;
}
