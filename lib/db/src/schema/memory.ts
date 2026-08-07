import { customType, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// pgvector firm memory (Phase 1): one embedding per (firm, corpus, source
// row) — the semantic index over a firm's OWN Clerk records. The pgvector
// extension is an infrastructure prerequisite of this column: the db
// package's push script pre-creates it (src/ensure-extensions.ts) and
// migration 0038 re-asserts it for boots that never push (Neon — Replit's
// PostgreSQL — ships it; CI uses the pgvector image; local dev installs the
// apt package).
//
// The platform embedding width. Fixed in DDL (vector(n) is a typmod), so
// the configured embedding model MUST emit exactly this many dimensions —
// the gateway validates and fails closed rather than storing a mis-sized
// vector.
export const EMBEDDING_DIMS = 1536;

// pgvector's text wire format is "[0.1,0.2,...]" — JSON-parseable by
// construction, and the driver value we send back is the same shape.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${EMBEDDING_DIMS})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    return JSON.parse(value as string) as number[];
  },
});

export const clerkMemoryEmbeddingsTable = pgTable(
  "clerk_memory_embeddings",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    // Corpus KEY as text (the filings catalogue rule): rows outlive
    // catalogue growth; the indexer and retrieval pin the closed set
    // (modules/clerk/memory/corpora.ts).
    corpus: text("corpus").notNull(),
    // The source row this embedding represents (a clerk case, an
    // escalation, ... — the corpus says which table). POINTER-ONLY: the
    // embedded text itself is never stored here; re-reading the source is
    // the only way back to content, so this table can never leak more than
    // an opaque direction in vector space.
    refId: uuid("ref_id").notNull(),
    // Hash of the embedded text at indexing time — PROVENANCE, not a live
    // change detector: both current corpora embed IMMUTABLE text (an Ask
    // question is never edited; an escalation's reason is written once at
    // creation — the reply path only ever touches operator_reply/
    // replied_at/status), so the indexer's anti-join checks existence +
    // model only. A future mutable-text corpus must compare this hash in
    // its candidate query before reusing the indexer, or it will serve
    // stale vectors.
    contentHash: text("content_hash").notNull(),
    // The embedding model that produced the vector; retrieval only ever
    // compares vectors from the SAME model (a model change re-indexes).
    model: text("model").notNull(),
    embedding: vector("embedding").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The natural key IS the cross-instance indexing gate (the filings
    // minting discipline): concurrent indexer passes race to one row per
    // source; the upsert overwrites unconditionally (last writer wins over
    // identical inputs).
    uniqueIndex("clerk_memory_natural_uq").on(t.firmId, t.corpus, t.refId),
    // NO ANN index on purpose: per-firm corpora are small (hundreds to low
    // thousands), so a firm-filtered EXACT scan is both fast and
    // recall-perfect — and pgvector 0.6's HNSW cannot filter by firm
    // inside the index anyway. Revisit when a corpus outgrows exact scan.
  ],
);

export type ClerkMemoryEmbedding = typeof clerkMemoryEmbeddingsTable.$inferSelect;
