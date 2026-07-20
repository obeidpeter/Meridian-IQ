import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  applyMigrations,
  rollbackLast,
  appliedVersions,
  migrations,
} from "./index.ts";

// CORE-06: forward migrations must be reversible. This exercises the real DB:
// apply -> assert guardrail objects exist -> roll back (newest first) -> assert
// they are gone -> re-apply so the environment is left in the migrated state.
//
// The walk is driven by the LADDER table below: one step per registered
// migration, each declaring the observable markers of that migration. The test
// fails loudly if a migration is added without a ladder step.

function makePool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run migration tests");
  }
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

async function functionExists(pool: pg.Pool, name: string): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM pg_proc WHERE proname = $1 LIMIT 1",
    [name],
  );
  return res.rowCount! > 0;
}

async function policyExists(pool: pg.Pool, table: string): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'meridian_tenant_isolation' LIMIT 1",
    [table],
  );
  return res.rowCount! > 0;
}

// 0005's Clerk tables are bypass-only (operators/auditors), not firm-keyed.
async function bypassPolicyExists(
  pool: pg.Pool,
  table: string,
): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'meridian_bypass_only' LIMIT 1",
    [table],
  );
  return res.rowCount! > 0;
}

// 0009 widens the Clerk tables to firm-keyed-or-bypass for client capture.
async function clerkTenantPolicyExists(
  pool: pg.Pool,
  table: string,
): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'meridian_clerk_tenant' LIMIT 1",
    [table],
  );
  return res.rowCount! > 0;
}

// 0004 widens the mutable-status window of the immutability triggers from
// draft-only to draft/validated/failed; detect which variant is installed by
// inspecting the function body.
async function lineTriggerAllowsFailed(pool: pg.Pool): Promise<boolean> {
  const res = await pool.query(
    `SELECT prosrc FROM pg_proc WHERE proname = 'meridian_enforce_line_immutability' LIMIT 1`,
  );
  const src: string | undefined = res.rows[0]?.prosrc;
  return src !== undefined && src.includes("'failed'");
}

// A named boolean observation with the value it must have.
interface Probe {
  desc: string;
  expect: boolean;
  check: (pool: pg.Pool) => Promise<boolean>;
}

const fn = (name: string): Probe => ({
  desc: `function ${name} exists`,
  expect: true,
  check: (pool) => functionExists(pool, name),
});
const pol = (table: string): Probe => ({
  desc: `RLS policy on ${table} exists`,
  expect: true,
  check: (pool) => policyExists(pool, table),
});
const bypass = (table: string): Probe => ({
  desc: `bypass-only policy on ${table} exists`,
  expect: true,
  check: (pool) => bypassPolicyExists(pool, table),
});
const clerkTenant = (table: string): Probe => ({
  desc: `Clerk tenant policy on ${table} exists`,
  expect: true,
  check: (pool) => clerkTenantPolicyExists(pool, table),
});
const triggerAllowsFailed = (): Probe => ({
  desc: "line immutability trigger allows failed-status edits",
  expect: true,
  check: lineTriggerAllowsFailed,
});
const not = (probe: Probe): Probe => ({
  desc: probe.desc,
  expect: !probe.expect,
  check: probe.check,
});

interface LadderStep {
  version: number;
  // Markers of this migration while it is the NEWEST applied migration. Used
  // as the survivor check right after the next-newer migration rolls back,
  // and (unless supersededBy) as part of the fully-applied assertions.
  atTop: Probe[];
  // What must hold immediately after THIS migration is rolled back — its own
  // markers gone, plus anything its `down` restores.
  afterRollback: Probe[];
  // A later migration replaces this one's markers, so its atTop probes hold
  // only until that migration applies and are excluded from the fully-applied
  // assertions.
  supersededBy?: number;
}

const LADDER: LadderStep[] = [
  {
    version: 1, // base guardrails
    atTop: [fn("meridian_block_mutations"), fn("meridian_purge_expired"), pol("invoices")],
    afterRollback: [not(fn("meridian_block_mutations")), not(pol("invoices"))],
  },
  {
    version: 2, // R2 guardrails
    atTop: [pol("bank_statements"), pol("b2c_report_batches")],
    afterRollback: [not(pol("bank_statements"))],
  },
  {
    version: 3, // push guardrails
    atTop: [pol("push_devices")],
    afterRollback: [not(pol("push_devices"))],
  },
  {
    version: 4, // fix-retry mutability
    atTop: [triggerAllowsFailed()],
    afterRollback: [not(triggerAllowsFailed())],
  },
  {
    version: 5, // Clerk guardrails (bypass-only tables)
    // 0009 supersedes the bypass-only policy on the two client-facing Clerk
    // tables, so this marker holds only while 0009 is not applied.
    supersededBy: 9,
    atTop: [bypass("clerk_cases")],
    afterRollback: [not(bypass("clerk_cases"))],
  },
  {
    version: 6, // Clerk eval guardrails
    atTop: [bypass("clerk_eval_runs")],
    afterRollback: [not(bypass("clerk_eval_runs"))],
  },
  {
    version: 7, // recurring/reminder guardrails
    atTop: [pol("recurring_invoice_templates"), pol("deadline_reminder_sends")],
    afterRollback: [
      not(pol("recurring_invoice_templates")),
      not(pol("deadline_reminder_sends")),
    ],
  },
  {
    version: 8, // invitation guardrails
    atTop: [pol("invitations")],
    afterRollback: [not(pol("invitations"))],
  },
  {
    version: 9, // clerk tenant read: firm-keyed-or-bypass replaces bypass-only
    atTop: [
      clerkTenant("clerk_cases"),
      clerkTenant("clerk_inference_calls"),
      not(bypass("clerk_cases")),
    ],
    // Rolling back restores 0005's bypass-only policy.
    afterRollback: [not(clerkTenant("clerk_cases")), bypass("clerk_cases")],
  },
  {
    version: 10, // eval fixture guardrails
    atTop: [bypass("clerk_eval_fixtures")],
    afterRollback: [not(bypass("clerk_eval_fixtures"))],
  },
  {
    version: 11, // digest guardrails
    atTop: [clerkTenant("clerk_digests")],
    afterRollback: [not(clerkTenant("clerk_digests"))],
  },
  {
    version: 12, // password-reset guardrails
    atTop: [bypass("password_resets")],
    afterRollback: [not(bypass("password_resets"))],
  },
  {
    version: 13, // tenant-coverage guardrails (review gap: 9 tenant tables)
    atTop: [
      pol("escalations"),
      pol("memberships"),
      pol("firms"),
      pol("operator_cases"),
      pol("alert_preferences"),
      pol("consent_records"),
    ],
    afterRollback: [
      not(pol("escalations")),
      not(pol("memberships")),
      not(pol("firms")),
      not(pol("alert_preferences")),
    ],
  },
  {
    version: 14, // async batch guardrails
    atTop: [clerkTenant("clerk_batches")],
    afterRollback: [not(clerkTenant("clerk_batches"))],
  },
  {
    version: 15, // client statement guardrails
    atTop: [clerkTenant("clerk_client_statements")],
    afterRollback: [not(clerkTenant("clerk_client_statements"))],
  },
  {
    version: 16, // red-team fixture guardrails
    atTop: [bypass("clerk_red_team_fixtures")],
    afterRollback: [not(bypass("clerk_red_team_fixtures"))],
  },
  {
    version: 17, // party-name alias guardrails
    atTop: [clerkTenant("party_name_aliases")],
    afterRollback: [not(clerkTenant("party_name_aliases"))],
  },
  {
    version: 18, // chase-log guardrails
    atTop: [clerkTenant("chase_log")],
    afterRollback: [not(clerkTenant("chase_log"))],
  },
  {
    version: 19, // staff notification-preference guardrails
    atTop: [pol("staff_notification_preferences")],
    afterRollback: [not(pol("staff_notification_preferences"))],
  },
  {
    version: 20, // bank-feed connection guardrails
    atTop: [pol("statement_connections"), pol("statement_sync_runs")],
    afterRollback: [
      not(pol("statement_connections")),
      not(pol("statement_sync_runs")),
    ],
  },
  {
    version: 21, // payment-intent guardrails
    atTop: [pol("payment_intents")],
    afterRollback: [not(pol("payment_intents"))],
  },
  {
    version: 22, // firm integrations guardrails (API keys + webhooks)
    atTop: [
      pol("firm_api_keys"),
      pol("firm_webhooks"),
      pol("firm_webhook_deliveries"),
    ],
    afterRollback: [
      not(pol("firm_api_keys")),
      not(pol("firm_webhooks")),
      not(pol("firm_webhook_deliveries")),
    ],
  },
];

// Markers that hold in the fully-migrated state: every step's atTop except
// those a later migration supersedes.
const FULLY_APPLIED = LADDER.filter((s) => s.supersededBy === undefined).flatMap(
  (s) => s.atTop,
);

async function assertProbes(
  pool: pg.Pool,
  probes: Probe[],
  when: string,
): Promise<void> {
  for (const probe of probes) {
    assert.equal(
      await probe.check(pool),
      probe.expect,
      `${probe.desc} should be ${probe.expect} ${when}`,
    );
  }
}

test("migrations apply and roll back cleanly in reverse order", async () => {
  const pool = makePool();
  try {
    // Every registered migration needs a ladder step (and nothing extra), so
    // adding a migration without extending the ladder fails here, not silently.
    assert.deepEqual(
      LADDER.map((s) => s.version),
      migrations.map((m) => m.version),
      "LADDER must have exactly one step per registered migration, in order",
    );
    // A dangling supersededBy would silently drop the step's markers from the
    // fully-applied assertions — it must name a real, later migration.
    for (const step of LADDER) {
      if (step.supersededBy !== undefined) {
        assert.ok(
          LADDER.some(
            (s) => s.version === step.supersededBy && s.version > step.version,
          ),
          `step ${step.version}: supersededBy ${step.supersededBy} must name a later registered migration`,
        );
      }
    }

    await applyMigrations(pool);
    await assertProbes(pool, FULLY_APPLIED, "after apply");
    const versions = await appliedVersions(pool);
    for (const m of migrations) {
      assert.ok(
        versions.includes(m.version),
        `version ${m.version} should be tracked after apply`,
      );
    }

    // Roll back newest first; after each step the rolled-back migration's
    // markers must be gone and the next-older migration's markers must survive.
    for (let i = LADDER.length - 1; i >= 0; i--) {
      const step = LADDER[i];
      const rolled = await rollbackLast(pool);
      assert.equal(
        rolled,
        step.version,
        `rollback should pop version ${step.version} next`,
      );
      await assertProbes(pool, step.afterRollback, `after rolling back ${step.version}`);
      if (i > 0) {
        await assertProbes(
          pool,
          LADDER[i - 1].atTop,
          `(must survive the ${step.version} rollback)`,
        );
      }
    }

    assert.equal(
      (await appliedVersions(pool)).length,
      0,
      "no versions should be tracked after full rollback",
    );

    // Leave the database in the fully-migrated state for the running app.
    await applyMigrations(pool);
    await assertProbes(pool, FULLY_APPLIED, "after re-apply");
  } finally {
    await pool.end();
  }
});
