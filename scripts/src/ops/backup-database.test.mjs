import test from "node:test";
import assert from "node:assert/strict";
import {
  DATABASE_SNAPSHOT_SQL,
  validateDatabaseSnapshot,
  databaseRoleRoots,
  createDatabaseSql,
  restoreDatabaseSql,
  compareDatabaseCreation,
  compareDatabaseSnapshot,
} from "./backup-database.mjs";

const target = "meridian_drill_database_test";
const acl = (grantor, grantee, privilege = "CONNECT", grantable = false) => ({
  grantor,
  grantee,
  privilege,
  grantable,
});
const baseline = () => ({
  database: "production_database",
  postgresMajor: 16,
  owner: "production_owner",
  encoding: "UTF8",
  localeProvider: "c",
  collate: "C.UTF-8",
  ctype: "C.UTF-8",
  icuLocale: null,
  icuRules: null,
  collationVersion: null,
  actualCollationVersion: null,
  acl: [
    acl("production_owner", "production_owner", "CREATE"),
    acl("production_owner", "production_owner", "CONNECT"),
    acl("production_owner", "production_owner", "TEMPORARY"),
    acl("production_owner", "runtime_login"),
  ],
  settings: [
    { role: null, name: "statement_timeout", value: "37s" },
    {
      role: "runtime_login",
      name: "search_path",
      value: '"$user", pg_catalog, public',
    },
  ],
});
const restored = (source) => ({ ...structuredClone(source), database: target });
const icu = () => ({
  ...baseline(),
  localeProvider: "i",
  icuLocale: "en-US",
  icuRules: "&V < w <<< W",
  collationVersion: "153.120",
  actualCollationVersion: "153.120",
});

test("snapshot SQL captures PG16 database metadata without authentication secrets or global settings", () => {
  for (const expression of [
    "d.datdba",
    "d.encoding",
    "d.datlocprovider",
    "d.datcollate",
    "d.datctype",
    "d.daticulocale",
    "d.daticurules",
    "d.datcollversion",
    "pg_catalog.pg_database_collation_actual_version(d.oid)",
    "pg_catalog.aclexplode(coalesce(d.datacl, pg_catalog.acldefault('d', d.datdba)))",
    "x.grantor",
    "x.grantee",
    "x.privilege_type",
    "x.is_grantable",
    "r.setrole = 0",
    "r.setdatabase = d.oid",
    "d.datname = pg_catalog.current_database()",
    "pg_catalog.substr(v.setting, pg_catalog.strpos(v.setting, '=') + 1)",
  ])
    assert.ok(DATABASE_SNAPSHOT_SQL.includes(expression), expression);
  assert.doesNotMatch(
    DATABASE_SNAPSHOT_SQL,
    /pg_authid|rolpassword|pg_shadow|ALTER |CREATE |INSERT |UPDATE |DELETE /,
  );
});

test("the confirmed UTF8 libc C.UTF-8 production metadata creates an explicit pristine target", () => {
  const source = baseline();
  assert.equal(validateDatabaseSnapshot(source), source);
  assert.equal(
    createDatabaseSql(source, target),
    "CREATE DATABASE \"meridian_drill_database_test\" WITH OWNER \"production_owner\" TEMPLATE template0 ENCODING E'UTF8' LOCALE_PROVIDER libc LC_COLLATE E'C.UTF-8' LC_CTYPE E'C.UTF-8';",
  );
  assert.doesNotMatch(
    createDatabaseSql(source, target),
    /COLLATION_VERSION|REFRESH|IF NOT EXISTS|DROP|BEGIN|production_database/,
  );
});

test("ICU locale and rules are explicit; recorded version is never forced onto a different provider", () => {
  const source = icu();
  const sql = createDatabaseSql(source, target);
  assert.match(sql, /LOCALE_PROVIDER icu/);
  assert.match(sql, /ICU_LOCALE E'en-US'/);
  assert.match(sql, /ICU_RULES E'&V < w <<< W'/);
  assert.doesNotMatch(sql, /153\.120|COLLATION_VERSION|REFRESH/);
  compareDatabaseCreation(source, restored(source), target);
  assert.throws(
    () =>
      compareDatabaseCreation(
        source,
        {
          ...restored(source),
          collationVersion: "154.1",
          actualCollationVersion: "154.1",
        },
        target,
      ),
    /collationVersion differs/,
  );
});

test("unsupported providers, PG majors and stale or unavailable collation versions fail closed", () => {
  for (const mutation of [
    { localeProvider: "builtin" },
    { localeProvider: "b" },
    { postgresMajor: 17 },
    { postgresMajor: "16" },
    { actualCollationVersion: "2.36" },
    { collationVersion: "2.36", actualCollationVersion: null },
    { icuLocale: "en" },
    { icuRules: "" },
  ])
    assert.throws(() =>
      createDatabaseSql({ ...baseline(), ...mutation }, target),
    );
  assert.throws(
    () => validateDatabaseSnapshot({ ...icu(), icuLocale: null }),
    /ICU locale/,
  );
  assert.throws(
    () =>
      validateDatabaseSnapshot({
        ...icu(),
        collationVersion: null,
        actualCollationVersion: null,
      }),
    /ICU collation version/,
  );
});

test("all helper writes are constrained to a distinct bounded scratch name", () => {
  for (const invalid of [
    "production_database",
    "postgres",
    "template0",
    "meridian_drill_",
    "meridian_drill_" + "a".repeat(41),
    'meridian_drill_x"; DROP DATABASE postgres;--',
    "meridian_drill_X",
    "meridian_drill_x\n",
    null,
  ]) {
    assert.throws(() => createDatabaseSql(baseline(), invalid));
    assert.throws(() => restoreDatabaseSql(baseline(), invalid));
  }
  assert.throws(
    () => createDatabaseSql({ ...baseline(), database: target }, target),
    /differ from source/,
  );
  assert.throws(
    () => compareDatabaseSnapshot(baseline(), baseline(), target),
    /wrong scratch/,
  );
});

test("SQL identifiers and literal values preserve quotes, backslashes and embedded equals", () => {
  const source = baseline();
  source.owner = 'owner"; SELECT 1;--';
  source.acl = [acl(source.owner, "reader'\\")];
  source.settings = [
    {
      role: "reader'\\",
      name: "application_name",
      value: "a='b';\\path\nnext",
    },
  ];
  const create = createDatabaseSql(source, target);
  assert.ok(create.includes('OWNER "owner""; SELECT 1;--" TEMPLATE'));
  const sql = restoreDatabaseSql(source, target);
  assert.ok(sql.includes('SET LOCAL ROLE "owner""; SELECT 1;--";'));
  assert.ok(sql.includes('TO "reader\'\\";'));
  assert.ok(
    sql.includes("SET \"application_name\" TO E'a=''b'';\\\\path\\nnext';"),
  );
  assert.doesNotMatch(sql, /production_database/);
});

test("role roots include owner, ACL grantors/grantees and scoped settings roles, not PUBLIC", () => {
  const source = baseline();
  source.acl.push(
    acl(source.owner, null),
    acl(source.owner, "delegated", "CONNECT", true),
    acl("delegated", "reader"),
  );
  source.settings.push({
    role: "settings_only",
    name: "timezone",
    value: "UTC",
  });
  assert.deepEqual(databaseRoleRoots(source), [
    "delegated",
    "production_owner",
    "reader",
    "runtime_login",
    "settings_only",
  ]);
});

test("ACL restore revokes fresh database defaults and preserves grantor chains and grant options", () => {
  const source = baseline();
  source.acl = [
    acl("z_grantor", "reader"),
    acl("a_grantor", "z_grantor", "CONNECT", true),
    acl(source.owner, "a_grantor", "CONNECT", true),
  ];
  const sql = restoreDatabaseSql(source, target);
  assert.match(sql, /^BEGIN;\nSET LOCAL ROLE "production_owner";/);
  assert.ok(
    sql.includes(`REVOKE ALL PRIVILEGES ON DATABASE "${target}" FROM PUBLIC;`),
  );
  assert.ok(
    sql.includes(
      `REVOKE ALL PRIVILEGES ON DATABASE "${target}" FROM "production_owner";`,
    ),
  );
  const ownerGrant = sql.indexOf('TO "a_grantor" WITH GRANT OPTION;');
  const delegated = sql.indexOf('TO "z_grantor" WITH GRANT OPTION;');
  const leaf = sql.indexOf('TO "reader";');
  assert.ok(ownerGrant < delegated && delegated < leaf);
  assert.ok(sql.includes('SET LOCAL ROLE "z_grantor";\nGRANT CONNECT'));
  assert.match(sql, /COMMIT;$/);
  assert.doesNotMatch(
    sql,
    /CREATE ROLE|ALTER ROLE [^\n]+ (?:SUPERUSER|PASSWORD)|GRANT ALL|CASCADE/,
  );
});

test("database and role-specific settings preserve scope and GUC list semantics", () => {
  const source = baseline();
  source.settings.push({
    role: "runtime_login",
    name: "temp_tablespaces",
    value: '"space, name", "a""b", plain',
  });
  const sql = restoreDatabaseSql(source, target);
  assert.ok(sql.includes(`ALTER DATABASE "${target}" RESET ALL;`));
  assert.ok(
    sql.includes(
      `ALTER ROLE "runtime_login" IN DATABASE "${target}" RESET ALL;`,
    ),
  );
  assert.ok(
    sql.includes(
      `ALTER DATABASE "${target}" SET "statement_timeout" TO E'37s';`,
    ),
  );
  assert.ok(
    sql.includes(
      `ALTER ROLE "runtime_login" IN DATABASE "${target}" SET "search_path" TO E'$user', E'pg_catalog', E'public';`,
    ),
  );
  assert.ok(
    sql.includes(`SET "temp_tablespaces" TO E'space, name', E'a"b', E'plain';`),
  );
  assert.ok(sql.indexOf("RESET ROLE;") < sql.indexOf("ALTER DATABASE"));
  assert.doesNotMatch(sql, /ALTER SYSTEM|SET SESSION AUTHORIZATION/);
});

test("malformed metadata, duplicate grants/settings and impossible grant chains are rejected", () => {
  const bad = [];
  bad.push({ ...baseline(), password: "never accepted" });
  bad.push({ ...baseline(), owner: "a".repeat(64) });
  bad.push({ ...baseline(), owner: "nul\0role" });
  bad.push({ ...baseline(), owner: "new\nline" });
  bad.push({ ...baseline(), encoding: "UTF8'; DROP DATABASE x;--" });
  bad.push({
    ...baseline(),
    acl: [acl("production_owner", null, "CONNECT", true)],
  });
  bad.push({
    ...baseline(),
    acl: [acl("production_owner", "reader", "SELECT")],
  });
  bad.push({ ...baseline(), acl: [acl("missing_grantor", "reader")] });
  bad.push({
    ...baseline(),
    acl: [acl("a", "b", "CONNECT", true), acl("b", "a", "CONNECT", true)],
  });
  bad.push({
    ...baseline(),
    acl: [acl("production_owner", "reader"), acl("production_owner", "reader")],
  });
  bad.push({
    ...baseline(),
    settings: [{ role: null, name: "search_path; RESET ALL", value: "public" }],
  });
  const source = baseline();
  bad.push({ ...source, settings: [...source.settings, source.settings[0]] });
  for (const value of bad) assert.throws(() => validateDatabaseSnapshot(value));
  for (const value of [
    "",
    " ",
    "public,",
    '"unterminated',
    "public,,other",
    '"quoted"suffix',
    "public other",
  ])
    assert.throws(
      () =>
        validateDatabaseSnapshot({
          ...baseline(),
          settings: [{ role: null, name: "search_path", value }],
        }),
      /setting list/,
    );
});

test("creation comparison precedes data restore and full comparison checks ACLs and settings", () => {
  const source = baseline();
  const actual = restored(source);
  actual.acl = [];
  actual.settings = [];
  compareDatabaseCreation(source, actual, target);
  assert.throws(
    () => compareDatabaseSnapshot(source, actual, target),
    /acl differs/,
  );
  actual.acl = structuredClone(source.acl);
  assert.throws(
    () => compareDatabaseSnapshot(source, actual, target),
    /settings differs/,
  );
});

test("full comparison ignores row ordering and detects each database-level regression", () => {
  const source = baseline();
  const actual = restored(source);
  actual.acl.reverse();
  actual.settings.reverse();
  actual.acl = actual.acl.map((entry) =>
    Object.fromEntries(Object.entries(entry).reverse()),
  );
  actual.settings = actual.settings.map((entry) =>
    Object.fromEntries(Object.entries(entry).reverse()),
  );
  compareDatabaseSnapshot(source, actual, target);
  for (const mutation of [
    { owner: "different_owner" },
    { encoding: "LATIN1" },
    { collate: "C" },
    { ctype: "C" },
    { collationVersion: "2.36", actualCollationVersion: "2.36" },
    { acl: [...source.acl, acl(source.owner, null, "TEMPORARY")] },
    {
      settings: [
        { role: null, name: "statement_timeout", value: "38s" },
        source.settings[1],
      ],
    },
    {
      settings: [
        { role: "runtime_login", name: "statement_timeout", value: "37s" },
        source.settings[1],
      ],
    },
  ])
    assert.throws(() =>
      compareDatabaseSnapshot(
        source,
        { ...restored(source), ...mutation },
        target,
      ),
    );
  assert.deepEqual(
    source,
    baseline(),
    "helpers must not mutate the source manifest",
  );
});
