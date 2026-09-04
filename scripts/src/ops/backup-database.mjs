import assert from "node:assert/strict";

// Run in the held source snapshot, and again on the scratch database to verify.
// Null role/grantee denotes database-wide settings/PUBLIC, never a role name.
export const DATABASE_SNAPSHOT_SQL = `SELECT pg_catalog.json_build_object(
  'database', d.datname,
  'postgresMajor', pg_catalog.current_setting('server_version_num')::int / 10000,
  'owner', pg_catalog.pg_get_userbyid(d.datdba),
  'encoding', pg_catalog.pg_encoding_to_char(d.encoding),
  'localeProvider', d.datlocprovider::text,
  'collate', d.datcollate, 'ctype', d.datctype,
  'icuLocale', d.daticulocale, 'icuRules', d.daticurules,
  'collationVersion', d.datcollversion,
  'actualCollationVersion', pg_catalog.pg_database_collation_actual_version(d.oid),
  'acl', (SELECT coalesce(pg_catalog.json_agg(pg_catalog.row_to_json(a)
    ORDER BY grantor, grantee NULLS FIRST, privilege), '[]'::json) FROM (
      SELECT pg_catalog.pg_get_userbyid(x.grantor) AS grantor,
        CASE WHEN x.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(x.grantee) END AS grantee,
        x.privilege_type AS privilege, x.is_grantable AS grantable
      FROM pg_catalog.aclexplode(coalesce(d.datacl, pg_catalog.acldefault('d', d.datdba))) x
    ) a),
  'settings', (SELECT coalesce(pg_catalog.json_agg(pg_catalog.row_to_json(s)
    ORDER BY role NULLS FIRST, name), '[]'::json) FROM (
      SELECT CASE WHEN r.setrole = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(r.setrole) END AS role,
        pg_catalog.lower(pg_catalog.split_part(v.setting, '=', 1)) AS name,
        pg_catalog.substr(v.setting, pg_catalog.strpos(v.setting, '=') + 1) AS value
      FROM pg_catalog.pg_db_role_setting r
      CROSS JOIN LATERAL pg_catalog.unnest(r.setconfig) AS v(setting)
      WHERE r.setdatabase = d.oid
    ) s)
) FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database();`;

const CREATION_FIELDS = [
  "postgresMajor",
  "owner",
  "encoding",
  "localeProvider",
  "collate",
  "ctype",
  "icuLocale",
  "icuRules",
  "collationVersion",
  "actualCollationVersion",
];
const PRIVILEGES = ["CONNECT", "CREATE", "TEMPORARY"];
// PG16 pg_dump uses this same GUC_LIST_QUOTE set. Lists cannot be emitted as
// one quoted scalar: that would turn a multi-schema search_path into one name.
const LIST_SETTINGS = new Set([
  "local_preload_libraries",
  "output_plugin_libraries",
  "search_path",
  "session_preload_libraries",
  "shared_preload_libraries",
  "temp_tablespaces",
  "unix_socket_directories",
]);
const sorted = (rows) =>
  [...rows].sort((a, b) => {
    const key = (row) =>
      JSON.stringify(
        Object.keys(row)
          .sort()
          .map((field) => [field, row[field]]),
      );
    const left = key(a),
      right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });

function text(value, label, allowEmpty = false) {
  assert.ok(
    typeof value === "string" &&
      (allowEmpty || value.length > 0) &&
      value.length <= 1_048_576 &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
      }),
    `invalid database ${label}`,
  );
  return value;
}

function name(value, label) {
  text(value, label);
  assert.ok(
    Buffer.byteLength(value, "utf8") <= 63 && !/[\r\n\t]/.test(value),
    `invalid database ${label}`,
  );
  return value;
}

const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
// Explicit escape strings are independent of standard_conforming_strings.
const literal = (value) =>
  `E'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "''")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}'`;

function fields(value, expected, label) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `invalid database ${label}`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `invalid database ${label} fields`,
  );
}

function settingList(value) {
  const items = [];
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(value[index] ?? "") && index < value.length) index++;
  };
  whitespace();
  // Empty raw lists need FROM CURRENT treatment; refuse rather than changing
  // them into a quoted empty identifier. Quoted empty items remain supported.
  assert.ok(index < value.length, "unsupported empty database setting list");
  while (index < value.length) {
    let item = "";
    if (value[index] === '"') {
      index++;
      let closed = false;
      while (index < value.length) {
        if (value[index] !== '"') {
          item += value[index++];
          continue;
        }
        index++;
        if (value[index] === '"') {
          item += '"';
          index++;
        } else {
          closed = true;
          break;
        }
      }
      assert.ok(closed, "invalid quoted database setting list");
    } else {
      while (
        index < value.length &&
        value[index] !== "," &&
        !/\s/.test(value[index])
      )
        item += value[index++];
      assert.ok(
        item.length && !item.includes('"'),
        "invalid database setting list item",
      );
    }
    items.push(item);
    whitespace();
    if (index === value.length) break;
    assert.equal(
      value[index++],
      ",",
      "invalid database setting list separator",
    );
    whitespace();
    assert.ok(
      index < value.length,
      "invalid trailing database setting list separator",
    );
  }
  return items;
}

function orderedAcl(snapshot) {
  const pending = sorted(snapshot.acl);
  const authority = new Map(
    PRIVILEGES.map((privilege) => [privilege, new Set([snapshot.owner])]),
  );
  const result = [];
  // Preserve grantors by creating their grant-option dependencies first.
  while (pending.length) {
    const index = pending.findIndex((entry) =>
      authority.get(entry.privilege).has(entry.grantor),
    );
    assert.ok(
      index >= 0,
      "unsupported database ACL grant chain without owner authority",
    );
    const [entry] = pending.splice(index, 1);
    result.push(entry);
    if (entry.grantable) authority.get(entry.privilege).add(entry.grantee);
  }
  return result;
}

export function validateDatabaseSnapshot(snapshot) {
  fields(
    snapshot,
    ["database", ...CREATION_FIELDS, "acl", "settings"],
    "snapshot",
  );
  name(snapshot.database, "name");
  name(snapshot.owner, "owner");
  assert.equal(
    snapshot.postgresMajor,
    16,
    "unsupported database PostgreSQL major",
  );
  assert.ok(
    typeof snapshot.encoding === "string" &&
      /^[A-Z][A-Z0-9_]{0,31}$/.test(snapshot.encoding),
    "invalid database encoding",
  );
  assert.ok(
    ["c", "i"].includes(snapshot.localeProvider),
    "unsupported database locale provider",
  );
  text(snapshot.collate, "collation");
  text(snapshot.ctype, "ctype");
  for (const field of [
    "icuLocale",
    "icuRules",
    "collationVersion",
    "actualCollationVersion",
  ])
    if (snapshot[field] !== null)
      text(snapshot[field], field, field === "icuRules");
  if (snapshot.localeProvider === "c") {
    assert.equal(snapshot.icuLocale, null, "libc database has ICU locale");
    assert.equal(snapshot.icuRules, null, "libc database has ICU rules");
  } else {
    text(snapshot.icuLocale, "ICU locale");
    text(snapshot.collationVersion, "ICU collation version");
  }
  assert.equal(
    snapshot.collationVersion,
    snapshot.actualCollationVersion,
    "database collation version is stale or unavailable; do not overwrite its version",
  );
  assert.ok(Array.isArray(snapshot.acl), "invalid database ACL");
  const grants = new Set();
  for (const entry of snapshot.acl) {
    fields(entry, ["grantor", "grantee", "privilege", "grantable"], "ACL");
    name(entry.grantor, "ACL grantor");
    if (entry.grantee !== null) name(entry.grantee, "ACL grantee");
    assert.ok(
      PRIVILEGES.includes(entry.privilege),
      "unsupported database ACL privilege",
    );
    assert.equal(
      typeof entry.grantable,
      "boolean",
      "invalid database ACL grant option",
    );
    assert.ok(
      entry.grantee !== null || !entry.grantable,
      "PUBLIC cannot receive database grant options",
    );
    const key = JSON.stringify([entry.grantor, entry.grantee, entry.privilege]);
    assert.ok(!grants.has(key), "duplicate database ACL entry");
    grants.add(key);
  }
  orderedAcl(snapshot);
  assert.ok(Array.isArray(snapshot.settings), "invalid database settings");
  const settings = new Set();
  for (const setting of snapshot.settings) {
    fields(setting, ["role", "name", "value"], "setting");
    if (setting.role !== null) name(setting.role, "settings role");
    assert.ok(
      typeof setting.name === "string" &&
        /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(setting.name) &&
        Buffer.byteLength(setting.name) <= 63,
      "invalid database setting name",
    );
    text(setting.value, "setting value", true);
    if (LIST_SETTINGS.has(setting.name)) settingList(setting.value);
    const key = JSON.stringify([setting.role, setting.name]);
    assert.ok(!settings.has(key), "duplicate database setting");
    settings.add(key);
  }
  return snapshot;
}

export function databaseRoleRoots(snapshot) {
  validateDatabaseSnapshot(snapshot);
  return [
    ...new Set(
      [
        snapshot.owner,
        ...snapshot.acl.flatMap((entry) => [entry.grantor, entry.grantee]),
        ...snapshot.settings.map((setting) => setting.role),
      ].filter((role) => role !== null),
    ),
  ].sort();
}

function scratch(snapshot, targetName) {
  validateDatabaseSnapshot(snapshot);
  assert.ok(
    typeof targetName === "string" &&
      /^meridian_drill_[a-z0-9_]{1,40}$/.test(targetName),
    "database target must be a fresh meridian_drill_<unique> scratch database",
  );
  assert.notEqual(
    targetName,
    snapshot.database,
    "database target must differ from source",
  );
  return identifier(targetName);
}

// Execute by itself on the maintenance connection; CREATE DATABASE cannot be
// inside a transaction. The caller must retain its existing fresh-target guard.
export function createDatabaseSql(snapshot, targetName) {
  const target = scratch(snapshot, targetName);
  const options = [
    `OWNER ${identifier(snapshot.owner)}`,
    "TEMPLATE template0",
    `ENCODING ${literal(snapshot.encoding)}`,
    `LOCALE_PROVIDER ${snapshot.localeProvider === "c" ? "libc" : "icu"}`,
    `LC_COLLATE ${literal(snapshot.collate)}`,
    `LC_CTYPE ${literal(snapshot.ctype)}`,
  ];
  if (snapshot.localeProvider === "i") {
    options.push(`ICU_LOCALE ${literal(snapshot.icuLocale)}`);
    if (snapshot.icuRules !== null)
      options.push(`ICU_RULES ${literal(snapshot.icuRules)}`);
  }
  // Never emit COLLATION_VERSION or REFRESH VERSION: compare the real provider.
  return `CREATE DATABASE ${target} WITH ${options.join(" ")};`;
}

// Call only for this helper's freshly created database, using the reviewed
// restore administrator. No source names, passwords, global role settings or
// cluster configuration are written. SQL errors must abort the caller's drill.
export function restoreDatabaseSql(snapshot, targetName) {
  const target = scratch(snapshot, targetName);
  const sql = [
    "BEGIN;",
    `SET LOCAL ROLE ${identifier(snapshot.owner)};`,
    `REVOKE ALL PRIVILEGES ON DATABASE ${target} FROM PUBLIC;`,
    `REVOKE ALL PRIVILEGES ON DATABASE ${target} FROM ${identifier(snapshot.owner)};`,
  ];
  for (const entry of orderedAcl(snapshot)) {
    sql.push(
      `SET LOCAL ROLE ${identifier(entry.grantor)};`,
      `GRANT ${entry.privilege} ON DATABASE ${target} TO ${entry.grantee === null ? "PUBLIC" : identifier(entry.grantee)}${entry.grantable ? " WITH GRANT OPTION" : ""};`,
    );
  }
  sql.push("RESET ROLE;", `ALTER DATABASE ${target} RESET ALL;`);
  for (const role of [
    ...new Set(
      snapshot.settings
        .map((setting) => setting.role)
        .filter((role) => role !== null),
    ),
  ].sort())
    sql.push(`ALTER ROLE ${identifier(role)} IN DATABASE ${target} RESET ALL;`);
  for (const setting of sorted(snapshot.settings)) {
    const subject =
      setting.role === null
        ? `DATABASE ${target}`
        : `ROLE ${identifier(setting.role)} IN DATABASE ${target}`;
    const values = LIST_SETTINGS.has(setting.name)
      ? settingList(setting.value)
      : [setting.value];
    sql.push(
      `ALTER ${subject} SET ${identifier(setting.name)} TO ${values.map(literal).join(", ")};`,
    );
  }
  sql.push("COMMIT;");
  return sql.join("\n");
}

export function compareDatabaseCreation(expected, actual, targetName) {
  scratch(expected, targetName);
  validateDatabaseSnapshot(actual);
  assert.equal(
    actual.database,
    targetName,
    "database verification reached the wrong scratch database",
  );
  for (const field of CREATION_FIELDS)
    assert.deepEqual(
      actual[field],
      expected[field],
      `restored database ${field} differs`,
    );
}

export function compareDatabaseSnapshot(expected, actual, targetName) {
  compareDatabaseCreation(expected, actual, targetName);
  for (const section of ["acl", "settings"])
    assert.deepEqual(
      sorted(actual[section]),
      sorted(expected[section]),
      `restored database ${section} differs`,
    );
}
