import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  sql,
} from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  NodePgSession,
  NodePgTransaction,
  type NodePgClient,
} from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "./schema/index.ts";

export interface DatabaseLifetime {
  active: boolean;
  parent?: DatabaseLifetime;
}

export function assertDatabaseLifetime(
  lifetime: DatabaseLifetime | undefined,
): void {
  for (let current = lifetime; current; current = current.parent) {
    if (!current.active)
      throw new Error("Database context is no longer active");
  }
}

const dialect = new PgDialect();
const extracted = extractTablesRelationalConfig(
  schema,
  createTableRelationsHelpers,
);
const relationalSchema = {
  fullSchema: schema,
  schema: extracted.tables,
  tableNamesMap: extracted.tableNamesMap,
};
type Transaction = NodePgTransaction<typeof schema, typeof extracted.tables>;
const lifetimes = new WeakMap<object, DatabaseLifetime>();

export function transactionLifetime(transaction: object): DatabaseLifetime {
  const lifetime = lifetimes.get(transaction);
  if (!lifetime)
    throw new Error("Transaction has no managed database lifetime");
  return lifetime;
}

// Drizzle's node-postgres prepared execute/all paths ultimately call client.query.
// Guard that one synchronous dispatch point, not lazy builders or Promise methods.
// The real PoolClient (including release) is never exposed to application handles.
export class ScopedTransaction extends NodePgTransaction<
  typeof schema,
  typeof extracted.tables
> {
  #client: PoolClient;
  #lifetime: DatabaseLifetime;
  #depth: number;
  #childActive = false;

  constructor(client: PoolClient, lifetime: DatabaseLifetime, depth = 0) {
    const guardedClient = {
      query: (...args: unknown[]) => {
        assertDatabaseLifetime(lifetime);
        return Reflect.apply(client.query, client, args);
      },
    };
    // This session never opens a root transaction or releases a client. Its
    // node-postgres driver needs only query; the owner handles BEGIN/COMMIT/ROLLBACK.
    const session = new NodePgSession(
      guardedClient as NodePgClient,
      dialect,
      relationalSchema,
    );
    super(dialect, session, relationalSchema, depth);
    this.#client = client;
    this.#lifetime = lifetime;
    this.#depth = depth;
    lifetimes.set(this, lifetime);
  }

  override async transaction<T>(
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    assertDatabaseLifetime(this.#lifetime);
    // Savepoints share one PostgreSQL stack, even with distinct names. Reserve
    // ownership before the first await, and retain it through terminal cleanup.
    if (this.#childActive)
      throw new Error(
        "Concurrent sibling transactions are not supported; await the active child transaction",
      );
    this.#childActive = true;
    const name = `sp${this.#depth + 1}`;
    const lifetime: DatabaseLifetime = { active: true, parent: this.#lifetime };
    let opened = false;
    try {
      await this.execute(sql.raw(`savepoint ${name}`));
      opened = true;
      const child = new ScopedTransaction(
        this.#client,
        lifetime,
        this.#depth + 1,
      );
      assertDatabaseLifetime(lifetime);
      const value = await fn(child);
      lifetime.active = false;
      // Cleanup uses the parent's guarded session, not the now-revoked child.
      // If the parent ended, root rollback already owns cleanup: no late SQL.
      await this.execute(sql.raw(`release savepoint ${name}`));
      return value;
    } catch (error) {
      lifetime.active = false;
      try {
        assertDatabaseLifetime(this.#lifetime);
      } catch {
        throw error;
      }
      if (opened) await this.execute(sql.raw(`rollback to savepoint ${name}`));
      throw error;
    } finally {
      lifetime.active = false;
      this.#childActive = false;
    }
  }
}
