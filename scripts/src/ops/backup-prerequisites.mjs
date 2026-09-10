import assert from "node:assert/strict";

const ROLE_FIELDS =
  "rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin,rolinherit";
const literal = (value) =>
  `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
const sorted = (items) =>
  [...items].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b), "en"),
  );

export function runtimeRoleName(value) {
  assert.ok(
    typeof value === "string" && /^[a-zA-Z_][a-zA-Z0-9_$-]{0,62}$/.test(value),
    "BACKUP_RUNTIME_ROLE must explicitly name the intended application login",
  );
  assert.notEqual(
    value,
    "meridian_app",
    "runtime login must be distinct from meridian_app",
  );
  return value;
}

// Follow both incoming and outgoing memberships, not just meridian_app's parents.
// Grantors are additional role prerequisites; no passwords or pg_authid are read.
export function rolePrerequisitesSql(runtimeRole, roots) {
  runtimeRoleName(runtimeRole);
  const seeds = roots
    ? `SELECT oid FROM pg_roles WHERE rolname IN (${roots.map(literal).join(",")})`
    : `SELECT refobjid AS oid FROM pg_shdepend
        WHERE refclassid='pg_authid'::regclass AND (
          dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) OR
          (dbid=0 AND classid='pg_database'::regclass AND objid=(SELECT oid FROM pg_database WHERE datname=current_database())))
       UNION SELECT datdba FROM pg_database WHERE datname=current_database()
       UNION SELECT setrole FROM pg_db_role_setting
         WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) AND setrole<>0
       UNION SELECT oid FROM pg_roles WHERE rolname IN ('meridian_app',${literal(runtimeRole)})`;
  return `WITH RECURSIVE seeds(oid) AS (${seeds}),
    connected(oid) AS (
      SELECT oid FROM seeds
      UNION SELECT CASE WHEN m.roleid=c.oid THEN m.member ELSE m.roleid END
        FROM connected c JOIN pg_auth_members m ON m.roleid=c.oid OR m.member=c.oid
    ), edges AS (
      SELECT m.* FROM pg_auth_members m WHERE m.roleid IN (SELECT oid FROM connected)
        OR m.member IN (SELECT oid FROM connected)
    ), required(oid) AS (
      SELECT oid FROM connected UNION SELECT grantor FROM edges
    )
    SELECT json_build_object(
      'roleRoots', (SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles WHERE oid IN (SELECT oid FROM seeds)),
      'roles', (SELECT json_agg(row_to_json(r) ORDER BY rolname) FROM
        (SELECT ${ROLE_FIELDS} FROM pg_roles WHERE oid IN (SELECT oid FROM required)) r),
      'memberships', (SELECT coalesce(json_agg(row_to_json(e) ORDER BY role,member,grantor),'[]') FROM (
        SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member,
          pg_get_userbyid(grantor) AS grantor, admin_option, inherit_option, set_option FROM edges) e),
      'runtimeLogin', json_build_object('name',${literal(runtimeRole)},
        'canSetRole',pg_has_role(${literal(runtimeRole)},'meridian_app','SET'))
    );`;
}

export const INSTALLED_EXTENSIONS_SQL = `SELECT coalesce(json_agg(row_to_json(e) ORDER BY name),'[]') FROM (
  SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace) e;`;

export const AVAILABLE_EXTENSIONS_SQL = `SELECT coalesce(json_agg(row_to_json(e) ORDER BY name),'[]') FROM (
  SELECT a.name,a.default_version AS "defaultVersion",
    ARRAY(SELECT version FROM pg_available_extension_versions v WHERE v.name=a.name ORDER BY version) AS versions
  FROM pg_available_extensions a) e;`;

export function assertPrerequisites(value) {
  assert.ok(
    Array.isArray(value.roleRoots) && value.roleRoots.includes("meridian_app"),
  );
  assert.equal(new Set(value.roleRoots).size, value.roleRoots.length);
  assert.ok(Array.isArray(value.roles) && value.roles.length);
  const roles = new Map(value.roles.map((role) => [role.rolname, role]));
  assert.equal(roles.size, value.roles.length, "duplicate role prerequisite");
  for (const role of value.roles) {
    assert.ok(typeof role.rolname === "string" && role.rolname.length);
    for (const field of ROLE_FIELDS.split(",").slice(1))
      assert.equal(typeof role[field], "boolean");
  }
  for (const root of value.roleRoots)
    assert.ok(roles.has(root), "missing root role");
  assert.ok(Array.isArray(value.memberships));
  const edgeIds = new Set();
  for (const edge of value.memberships) {
    for (const field of ["role", "member", "grantor"])
      assert.ok(roles.has(edge[field]), "missing membership role");
    for (const field of ["admin_option", "inherit_option", "set_option"])
      assert.equal(typeof edge[field], "boolean");
    const id = JSON.stringify([edge.role, edge.member, edge.grantor]);
    assert.ok(!edgeIds.has(id), "duplicate membership edge");
    edgeIds.add(id);
  }
  const name = runtimeRoleName(value.runtimeLogin?.name);
  const runtime = roles.get(name);
  assert.ok(
    runtime?.rolcanlogin && !runtime.rolsuper,
    "intended runtime must be a non-superuser login",
  );
  assert.ok(
    value.roleRoots.includes(name),
    "runtime login must be a role root",
  );
  assert.equal(
    value.runtimeLogin.canSetRole,
    true,
    "runtime login cannot SET ROLE meridian_app",
  );
  const reachable = new Set([name]);
  for (let size = -1; size !== reachable.size; ) {
    size = reachable.size;
    for (const edge of value.memberships)
      if (edge.set_option && reachable.has(edge.member))
        reachable.add(edge.role);
  }
  assert.ok(
    reachable.has("meridian_app"),
    "no SET-enabled runtime membership path",
  );
  assert.ok(
    Array.isArray(value.extensions) && value.extensions.length,
    "extension baseline missing",
  );
  assert.equal(
    new Set(value.extensions.map((e) => e.name)).size,
    value.extensions.length,
  );
  for (const extension of value.extensions)
    for (const field of ["name", "version", "schema"])
      assert.ok(
        typeof extension[field] === "string" && extension[field].length,
        "invalid extension baseline",
      );
}

export function compareRolePrerequisites(expected, actual) {
  for (const section of ["roleRoots", "roles", "memberships"])
    assert.deepEqual(
      sorted(actual[section]),
      sorted(expected[section]),
      `restore ${section} prerequisites differ; provision reviewed roles/memberships separately`,
    );
  assert.deepEqual(
    actual.runtimeLogin,
    expected.runtimeLogin,
    "runtime SET ROLE capability differs",
  );
}

export function assertExtensionAvailability(expected, available) {
  for (const extension of expected) {
    const target = available.find((item) => item.name === extension.name);
    assert.ok(
      target?.versions.includes(extension.version),
      `extension ${extension.name} version ${extension.version} is unavailable`,
    );
    assert.equal(
      target.defaultVersion,
      extension.version,
      `extension ${extension.name} default differs; provision exact backup version before restore`,
    );
  }
}

export function compareExtensions(expected, actual) {
  assert.deepEqual(
    sorted(actual),
    sorted(expected),
    "restored extension versions/schemas differ from backup",
  );
}
