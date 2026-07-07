import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // `_schema_migrations` is owned by the SQL migration runner (see
  // src/migrations), not by Drizzle. Exclude it so `drizzle push` never proposes
  // dropping it — that table records which guardrail migrations have been applied
  // and losing it would re-run or orphan them.
  tablesFilter: ["*", "!_schema_migrations"],
});
