import { timestamp, uuid } from "drizzle-orm/pg-core";

// Shared column factories for the chains repeated across the schema files.
// Each factory returns a FRESH builder per call — drizzle mutates builders
// when a table claims them, so a shared const instance would be reused across
// tables and corrupt the generated schema. Always call these, never share the
// result.
//
// Deliberately not re-exported from ./index.ts: these are schema-authoring
// helpers, not part of the package's "./schema" export surface.

/** `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` */
export const id = () => uuid("id").primaryKey().defaultRandom();

/** `created_at timestamptz NOT NULL DEFAULT now()` */
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** `updated_at timestamptz NOT NULL DEFAULT now()`, refreshed on every ORM update. */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
