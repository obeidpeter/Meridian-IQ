import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, pruneBackups } from "./backup.mjs";
import { restoreDrill } from "./restore-drill.mjs";
import { OPS_OUTPUT_LIMIT, run } from "./common.mjs";
import {
  parseSnapshot,
  snapshotSql,
  withBackupSnapshot,
} from "./backup-snapshot.mjs";
import {
  loadBackupManifest,
  recordRecoveryHeartbeat,
  recordRecoveryFailure,
  sha256,
  snapshotDigest,
} from "./recovery-evidence.mjs";
import { syncBackupDirectory } from "./backup-durability.mjs";
import {
  assertPrerequisites,
  rolePrerequisitesSql,
} from "./backup-prerequisites.mjs";
import { heartbeatCheck } from "../../../artifacts/api-server/src/modules/desk/release-readiness-checks.ts";

// Windows unit fixtures simulate only the unavailable directory-flush boundary.
// CLI/real-PG integration has no bypass and uses the real fsync implementation.
const fixtureDirectorySync =
  process.platform === "win32" ? () => {} : syncBackupDirectory;

const runtimeRole = {
  rolname: "meridian_app",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolcanlogin: false,
  rolinherit: true,
};
const catalog = {
  postgresMajor: 16,
  role: { ...runtimeRole, schema_create: false },
  memberships: [],
  tables: [
    {
      name: "invoices",
      rls: true,
      forced: true,
      app_owner: false,
      columns: ["firm_id"],
      grants: ["SELECT"],
    },
  ],
  columns: [{ table_name: "invoices", column_name: "firm_id" }],
  enums: [],
  policies: [
    {
      tablename: "invoices",
      policyname: "tenant",
      qual: "firm_id = current_setting('app.firm_id')::uuid",
    },
  ],
  triggers: [
    {
      table_name: "invoices",
      name: "immutable",
      enabled: "O",
      definition: "BEFORE UPDATE",
    },
  ],
  functions: [{ name: "meridian_immutable", definition: "RAISE EXCEPTION" }],
  constraints: [
    { name: "positive", validated: true, definition: "CHECK (id > 0)" },
  ],
  indexes: [
    {
      name: "primary",
      valid: true,
      ready: true,
      definition: "CREATE UNIQUE INDEX primary ON invoices (id)",
    },
  ],
  migrations: [{ version: 49, name: "pre_upgrade" }],
};
const baseline = () => ({
  snapshot: "00000003-00000011-1",
  database: "source",
  createdAt: new Date().toISOString(),
  catalog: structuredClone(catalog),
  roles: [
    { ...runtimeRole },
    {
      ...runtimeRole,
      rolname: "meridian_login",
      rolcanlogin: true,
      rolinherit: false,
      rolbypassrls: true,
    },
    { ...runtimeRole, rolname: "owner", rolcanlogin: true, rolsuper: true },
  ],
  roleRoots: ["meridian_app", "meridian_login", "owner"],
  memberships: [
    {
      role: "meridian_app",
      member: "meridian_login",
      grantor: "owner",
      admin_option: false,
      inherit_option: false,
      set_option: true,
    },
  ],
  runtimeLogin: { name: "meridian_login", canSetRole: true },
  extensions: [
    { name: "plpgsql", version: "1.0", schema: "pg_catalog" },
    { name: "vector", version: "0.8.0", schema: "public" },
  ],
  databaseProperties: {
    database: "source",
    postgresMajor: 16,
    owner: "owner",
    encoding: "UTF8",
    localeProvider: "c",
    collate: "C",
    ctype: "C",
    icuLocale: null,
    icuRules: null,
    collationVersion: null,
    actualCollationVersion: null,
    acl: ["CONNECT", "CREATE", "TEMPORARY"].map((privilege) => ({
      grantor: "owner",
      grantee: "owner",
      privilege,
      grantable: false,
    })),
    settings: [
      { role: null, name: "application_name", value: "backup-fixture" },
      {
        role: "meridian_login",
        name: "search_path",
        value: "public, pg_catalog",
      },
    ],
  },
  rowCounts: { invoices: "7" },
});
const temp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-recovery-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function fixture(t, source = "postgresql://localhost/source") {
  const dir = temp(t);
  const heartbeats = [];
  const snapshot = baseline();
  const producerCalls = [];
  const saved = await backup(
    {
      DATABASE_URL: source,
      BACKUP_DIR: dir,
      BACKUP_RUNTIME_ROLE: "meridian_login",
    },
    {
      syncDirectory: fixtureDirectorySync,
      snapshot: async (url, use) => {
        assert.equal(url, source);
        return use(snapshot);
      },
      run: (command, args, options) => {
        producerCalls.push({ command, args, options });
        if (command === "pg_dump") {
          assert.equal(args[args.indexOf("--snapshot") + 1], snapshot.snapshot);
          assert.ok(!args.includes("--file"));
          writeFileSync(options.stdio[1], "retained archive bytes");
          return { status: 0 };
        }
        assert.equal(command, "pg_restore");
        return { status: 0, stdout: "1; archive entry\n" };
      },
      query: (_url, sql) => heartbeats.push(sql),
      log: () => {},
    },
  );
  const env = {
    DATABASE_URL: source,
    BACKUP_MANIFEST: saved.manifestFile,
    BACKUP_MANIFEST_SHA256: saved.manifestSha256,
    DRILL_DATABASE_DISPOSABLE: "1",
    DRILL_CONFIRM_TARGET: "meridian_drill_test",
    DRILL_DATABASE_URL: "postgresql://localhost/meridian_drill_test",
  };
  const calls = [];
  let marker;
  const deps = {
    log: () => {},
    run: (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(
        command,
        "pg_restore",
        "restore never creates a replacement dump",
      );
      assert.equal(readFileSync(args.at(-1), "utf8"), "retained archive bytes");
      assert.notEqual(args.at(-1), path.join(dir, saved.manifest.archive.file));
      return { status: 0 };
    },
    catalog: (url) => {
      assert.equal(url, env.DRILL_DATABASE_URL);
      return structuredClone(catalog);
    },
    query: (url, sql) => {
      calls.push({ url, sql });
      assert.ok(!/DROP DATABASE|--clean/.test(sql));
      if (sql === "SELECT current_database()") return "source";
      if (sql.startsWith("WITH RECURSIVE")) {
        const { roles, roleRoots, memberships, runtimeLogin } = saved.manifest;
        return JSON.stringify({ roles, roleRoots, memberships, runtimeLogin });
      }
      if (sql.includes("FROM pg_available_extensions"))
        return JSON.stringify(
          saved.manifest.extensions.map((e) => ({
            name: e.name,
            defaultVersion: e.version,
            versions: [e.version],
          })),
        );
      if (sql.includes("FROM pg_extension"))
        return JSON.stringify(saved.manifest.extensions);
      if (sql.includes("'localeProvider'"))
        return JSON.stringify({
          ...saved.manifest.databaseProperties,
          database: "meridian_drill_test",
        });
      if (sql.includes("REVOKE ALL PRIVILEGES ON DATABASE")) return "";
      if (sql.includes("SET LOCAL SESSION AUTHORIZATION"))
        return JSON.stringify({
          sessionUser: "meridian_login",
          currentUser: "meridian_app",
        });
      if (sql.startsWith("CREATE DATABASE")) return "";
      if (sql.startsWith("COMMENT ON DATABASE")) {
        marker = sql.match(/IS '([^']+)'/)[1];
        return "";
      }
      if (sql.includes("shobj_description"))
        return JSON.stringify({ database: "meridian_drill_test", marker });
      if (sql.startsWith("SELECT count")) {
        assert.equal(url, env.DRILL_DATABASE_URL);
        return "7";
      }
      if (sql.includes("INSERT INTO operational_heartbeats")) {
        heartbeats.push(sql);
        return "";
      }
      assert.fail(`unexpected query: ${sql}`);
    },
  };
  return { dir, snapshot, saved, env, deps, calls, heartbeats, producerCalls };
}

test("ops capture supports catalogs above 1 MiB but remains bounded", () => {
  const result = run(process.execPath, [
    "-e",
    "process.stdout.write(Buffer.alloc(1100000,120))",
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.length, 1_100_000);
  assert.throws(
    () =>
      run(process.execPath, [
        "-e",
        `process.stdout.write(Buffer.alloc(${OPS_OUTPUT_LIMIT + 100_000},120))`,
      ]),
    /ENOBUFS/,
  );
});

test("backup binds snapshot, archive and independently trusted manifest hashes", async (t) => {
  const f = await fixture(t);
  const loaded = loadBackupManifest(
    f.saved.manifestFile,
    f.saved.manifestSha256,
  );
  assert.equal(loaded.manifest.snapshotSha256, snapshotDigest(f.snapshot));
  assert.equal(f.saved.metadata.sha256, sha256("retained archive bytes"));
  assert.equal(f.saved.metadata.snapshotSha256, loaded.manifest.snapshotSha256);
  assert.equal(f.saved.metadata.evidenceVersion, 2);
  assert.equal(f.heartbeats.length, 1);
  assert.match(
    path.basename(loaded.archive),
    /^meridian-\d{8}T\d{6}Z-[a-f0-9]{32}\.dump$/,
  );
});

test("restore uses old backup-time semantics and counts, never current source baseline", async (t) => {
  const f = await fixture(t);
  const result = await restoreDrill(f.env, f.deps);
  assert.equal(result.backupSha256, f.saved.metadata.sha256);
  assert.equal(result.evidenceVersion, 2);
  assert.equal(result.snapshotSha256, f.saved.metadata.snapshotSha256);
  assert.equal(result.securityCatalogVerified, true);
  assert.equal(result.allTableCountsVerified, true);
  assert.equal(f.heartbeats.length, 2);
  assert.equal(
    f.calls.filter((c) => c.sql?.startsWith("CREATE DATABASE")).length,
    1,
  );
  assert.ok(
    !f.calls.some(
      (c) => c.url === f.env.DATABASE_URL && c.sql?.startsWith("SELECT count"),
    ),
  );
});

test("untrusted sidecars, corrupt archives and stale/future baselines refuse before DB commands", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    restoreDrill({ ...f.env, BACKUP_MANIFEST_SHA256: undefined }, f.deps),
    /trusted/,
  );
  const original = readFileSync(f.saved.manifestFile);
  writeFileSync(
    f.saved.manifestFile,
    Buffer.concat([original, Buffer.from(" ")]),
  );
  writeFileSync(
    `${f.saved.manifestFile}.sha256`,
    sha256(readFileSync(f.saved.manifestFile)),
  );
  await assert.rejects(restoreDrill(f.env, f.deps), /manifest checksum/);
  writeFileSync(f.saved.manifestFile, original);
  for (const offset of [-25 * 3600_000, 3600_000]) {
    const value = {
      ...f.saved.manifest,
      createdAt: new Date(Date.now() + offset).toISOString(),
    };
    const bytes = JSON.stringify(value);
    writeFileSync(f.saved.manifestFile, bytes);
    await assert.rejects(
      restoreDrill({ ...f.env, BACKUP_MANIFEST_SHA256: sha256(bytes) }, f.deps),
      /stale, future/,
    );
  }
  writeFileSync(f.saved.manifestFile, original);
  writeFileSync(
    path.join(f.dir, f.saved.manifest.archive.file),
    "tampered archive bytes",
  );
  await assert.rejects(restoreDrill(f.env, f.deps), /archive (size|checksum)/);
  assert.equal(f.calls.length, 0);
});

test("scratch confirmation, host aliases, admin mismatch and URL overrides refuse before commands", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { DRILL_DATABASE_DISPOSABLE: undefined },
    { DRILL_CONFIRM_TARGET: "wrong" },
    { DRILL_ADMIN_URL: "postgresql://other-host/postgres" },
    { DRILL_ADMIN_URL: "postgresql://localhost:5433/postgres" },
    {
      DRILL_DATABASE_URL:
        "postgresql://localhost/meridian_drill_test?dbname=source",
    },
    {
      DATABASE_URL: "postgresql://localhost/meridian_drill_test",
      DRILL_DATABASE_URL: "postgresql://127.0.0.1/meridian_drill_test",
    },
  ])
    await assert.rejects(restoreDrill({ ...f.env, ...changes }, f.deps));
  assert.equal(f.calls.length, 0);
});

test("occupied or misrouted target and missing/escalated roles never reach restore", async (t) => {
  const f = await fixture(t);
  for (const mode of [
    "occupied",
    "misrouted",
    "missing role",
    "escalated role",
  ]) {
    f.calls.length = 0;
    const query = (url, sql) => {
      if (mode === "occupied" && sql.startsWith("CREATE DATABASE"))
        throw new Error("already exists");
      if (mode === "misrouted" && sql.includes("shobj_description"))
        return JSON.stringify({ database: "source", marker: "wrong" });
      if (mode === "missing role" && sql.startsWith("WITH RECURSIVE"))
        return JSON.stringify({ ...f.snapshot, roles: [] });
      if (mode === "escalated role" && sql.startsWith("WITH RECURSIVE"))
        return JSON.stringify({
          ...f.snapshot,
          roles: f.snapshot.roles.map((role) => ({ ...role, rolsuper: true })),
        });
      return f.deps.query(url, sql);
    };
    await assert.rejects(restoreDrill(f.env, { ...f.deps, query }));
    assert.equal(
      f.calls.filter(
        (c) => c.command === "pg_restore" && c.args.includes("--exit-on-error"),
      ).length,
      0,
    );
  }
  assert.equal(f.heartbeats.length, 1);
});

test("restore fails closed on changed policies, triggers, constraints, privileges and row counts", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (c) => {
      c.policies[0].qual = "firm_id IS NOT NULL";
    },
    (c) => {
      c.triggers[0].enabled = "D";
    },
    (c) => {
      c.constraints[0].definition = "CHECK (id >= 0)";
    },
    (c) => {
      c.role.rolbypassrls = true;
    },
    (c) => {
      c.migrations[0].version = 54;
    },
  ]) {
    const changed = structuredClone(catalog);
    mutate(changed);
    await assert.rejects(
      restoreDrill(f.env, { ...f.deps, catalog: () => changed }),
    );
  }
  await assert.rejects(
    restoreDrill(f.env, {
      ...f.deps,
      query: (url, sql) =>
        sql.startsWith("SELECT count") ? "8" : f.deps.query(url, sql),
    }),
    /count differs/,
  );
  assert.equal(
    f.heartbeats.filter((sql) => sql.includes("last_succeeded_at")).length,
    1,
  );
  assert.equal(
    f.heartbeats.filter((sql) => sql.includes("last_failed_at")).length,
    6,
  );
});

test("retention refuses symlinked bundles and preserves unrelated/in-progress files", async (t) => {
  const f = await fixture(t);
  const incomplete = `meridian-20000101T000000Z-${"a".repeat(32)}.dump`;
  writeFileSync(path.join(f.dir, incomplete), "in progress");
  writeFileSync(path.join(f.dir, "unrelated.txt"), "keep");
  pruneBackups(f.dir, 1, f.saved.manifest.archive.file);
  assert.equal(
    readFileSync(path.join(f.dir, incomplete), "utf8"),
    "in progress",
  );
  assert.ok(readdirSync(f.dir).includes("unrelated.txt"));
  // Directory junctions also exercise the non-file refusal on Windows without symlink privileges.
  const unsafe = path.join(
    f.dir,
    `meridian-20000102T000000Z-${"b".repeat(32)}.dump`,
  );
  const target = temp(t);
  symlinkSync(
    target,
    unsafe,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => pruneBackups(f.dir, 1, f.saved.manifest.archive.file),
    /unsafe/,
  );
  assert.ok(readdirSync(f.dir).includes(f.saved.manifest.archive.file));
});

test("persistent psql snapshot stays held through dump and exits on success/failure", async () => {
  const b = baseline();
  const lines = [
    JSON.stringify({
      snapshot: b.snapshot,
      database: b.database,
      createdAt: b.createdAt,
    }),
    JSON.stringify(b.catalog),
    JSON.stringify({
      roles: b.roles,
      roleRoots: b.roleRoots,
      memberships: b.memberships,
      runtimeLogin: b.runtimeLogin,
    }),
    JSON.stringify(b.extensions),
    JSON.stringify(b.databaseProperties),
    JSON.stringify({ table: "invoices", rows: "7" }),
  ];
  assert.equal(parseSnapshot(lines).snapshot, b.snapshot);
  assert.match(snapshotSql("meridian_login"), /REPEATABLE READ READ ONLY/);
  assert.match(snapshotSql("meridian_login"), /pg_export_snapshot/);
  assert.match(snapshotSql("meridian_login"), /\\gexec/);
  let child;
  const launch = (_command, args, options) => {
    assert.equal(args[0], "postgresql://runtime@localhost/source");
    assert.equal(options.env.PGPASSWORD, "snapshot-secret");
    assert.doesNotMatch(JSON.stringify(args), /snapshot-secret/);
    const output = lines.join("\n") + "\nMERIDIAN_BACKUP_SNAPSHOT_READY\n";
    child = spawn(
      process.execPath,
      [
        "-e",
        `let sent=false;process.stdin.on('data',data=>{if(!sent){sent=true;process.stdout.write(${JSON.stringify(output)})}else if(data.toString().includes('ROLLBACK')){process.exit(0)}})`,
      ],
      options,
    );
    return child;
  };
  await withBackupSnapshot(
    "postgresql://runtime:snapshot-secret@localhost/source",
    async (snapshot) => {
      assert.equal(child.exitCode, null);
      assert.deepEqual(snapshot.rowCounts, { invoices: "7" });
    },
    "meridian_login",
    launch,
  );
  assert.equal(child.exitCode, 0);
  await assert.rejects(
    withBackupSnapshot(
      "postgresql://runtime:snapshot-secret@localhost/source",
      async () => {
        throw new Error("dump failed");
      },
      "meridian_login",
      launch,
    ),
    /dump failed/,
  );
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("duplicate invocation refuses before capture; sequential files are unique and failed dumps publish no success", async (t) => {
  const directory = temp(t);
  const env = {
    DATABASE_URL: "postgresql://localhost/source",
    BACKUP_DIR: directory,
    BACKUP_RUNTIME_ROLE: "meridian_login",
  };
  let heartbeats = 0;
  let failures = 0;
  let captures = 0;
  let releaseCapture;
  const held = new Promise((resolve) => {
    releaseCapture = resolve;
  });
  const deps = {
    syncDirectory: fixtureDirectorySync,
    snapshot: async (_url, use) => {
      captures++;
      await held;
      return use(baseline());
    },
    query: (_url, sql) => {
      if (sql.includes("last_failed_at")) failures++;
      else heartbeats++;
    },
    log: () => {},
    run: (command, _args, options) => {
      if (command === "pg_dump")
        writeFileSync(options.stdio[1], "retained archive bytes");
      return { status: 0, stdout: "1; archive entry\n" };
    },
  };
  const pending = backup(env, deps);
  try {
    await assert.rejects(backup(env, deps), /EEXIST/);
    assert.equal(captures, 1);
    assert.equal(heartbeats, 0);
    assert.equal(failures, 0);
    assert.equal(
      readdirSync(directory).filter((name) => name.endsWith(".dump")).length,
      1,
    );
    assert.ok(
      readdirSync(directory).includes(".meridian-backup-operation.lock"),
    );
  } finally {
    releaseCapture();
  }
  const a = await pending;
  const b = await backup(env, deps);
  assert.notEqual(a.manifest.archive.file, b.manifest.archive.file);
  assert.equal(heartbeats, 2);
  for (const saved of [a, b])
    assert.equal(
      readFileSync(path.join(directory, saved.manifest.archive.file), "utf8"),
      "retained archive bytes",
    );
  const before = readdirSync(directory).sort();
  await assert.rejects(
    backup(env, {
      ...deps,
      run: (command, args, options) => {
        if (command === "pg_dump") {
          writeFileSync(options.stdio[1], "partial");
          return { status: 1 };
        }
        return deps.run(command, args, options);
      },
    }),
    /pg_dump failed/,
  );
  assert.deepEqual(readdirSync(directory).sort(), before);
  assert.equal(heartbeats, 2);
  assert.equal(failures, 1);
});

test("cross-directory publication rejects older evidence and retains its verified archive without pruning", async (t) => {
  const current = await fixture(t);
  const directory = temp(t);
  const snapshot = {
    ...baseline(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  };
  let attempted = false;
  await assert.rejects(
    backup(
      {
        DATABASE_URL: current.env.DATABASE_URL,
        BACKUP_DIR: directory,
        BACKUP_KEEP: "1",
        BACKUP_RUNTIME_ROLE: "meridian_login",
      },
      {
        syncDirectory: fixtureDirectorySync,
        snapshot: async (_url, use) => use(snapshot),
        run: (command, _args, options) => {
          if (command === "pg_dump")
            writeFileSync(options.stdio[1], "older retained archive");
          return { status: 0, stdout: "1; archive entry\n" };
        },
        query: (_url, sql) => {
          attempted = true;
          assert.match(sql, /ON CONFLICT/);
          assert.match(
            sql,
            /operational_heartbeats.metadata->>'createdAt'\)::timestamptz\s*<= \(excluded.metadata->>'createdAt'\)::timestamptz/,
          );
          assert.match(sql, /IF NOT FOUND THEN\s*RAISE EXCEPTION/);
          throw new Error("refusing older backup snapshot");
        },
        log: () => {},
      },
    ),
    /older backup snapshot/,
  );
  assert.equal(attempted, true);
  const archive = readdirSync(directory).find((name) => name.endsWith(".dump"));
  assert.ok(archive);
  assert.equal(
    readFileSync(path.join(directory, archive), "utf8"),
    "older retained archive",
  );
  assert.ok(readdirSync(directory).includes(`${archive}.manifest.json`));
  assert.ok(!readdirSync(directory).some((name) => name.endsWith(".lock")));
  assert.equal(
    readFileSync(
      path.join(current.dir, current.saved.manifest.archive.file),
      "utf8",
    ),
    "retained archive bytes",
  );
  recordRecoveryHeartbeat("fixture", "restore_drill", {}, (_url, sql) => {
    assert.doesNotMatch(sql, /WHERE operational_heartbeats/);
  });
});

test("snapshot subprocess malformed output and early exit never execute a dump", async () => {
  for (const code of [
    "process.exit(3)",
    "process.stdout.write('bad JSON\\nMERIDIAN_BACKUP_SNAPSHOT_READY\\n');process.stdin.resume()",
  ]) {
    let used = false;
    await assert.rejects(
      withBackupSnapshot(
        "postgresql://localhost/source",
        () => {
          used = true;
        },
        "meridian_login",
        (_command, _args, options) =>
          spawn(process.execPath, ["-e", code], options),
      ),
    );
    assert.equal(used, false);
  }
});

test("retention failure preserves both the newly verified archive and previous evidence files", async (t) => {
  const f = await fixture(t);
  const unsafe = path.join(
    f.dir,
    `meridian-20000101T000000Z-${"d".repeat(32)}.dump`,
  );
  symlinkSync(
    temp(t),
    unsafe,
    process.platform === "win32" ? "junction" : "dir",
  );
  let recorded = false;
  await assert.rejects(
    backup(
      {
        DATABASE_URL: f.env.DATABASE_URL,
        BACKUP_DIR: f.dir,
        BACKUP_KEEP: "1",
        BACKUP_RUNTIME_ROLE: "meridian_login",
      },
      {
        syncDirectory: fixtureDirectorySync,
        snapshot: async (_url, use) => use(baseline()),
        run: (command, _args, options) => {
          if (command === "pg_dump")
            writeFileSync(options.stdio[1], "new verified archive");
          return { status: 0, stdout: "1; archive entry\n" };
        },
        query: () => {
          recorded = true;
        },
        log: () => {},
      },
    ),
    /unsafe backup retention entry/,
  );
  assert.equal(recorded, true);
  const manifests = readdirSync(f.dir).filter((name) =>
    name.endsWith(".manifest.json"),
  );
  assert.equal(manifests.length, 2);
  for (const file of manifests) {
    const { archive } = loadBackupManifest(
      path.join(f.dir, file),
      sha256(readFileSync(path.join(f.dir, file))),
    );
    assert.ok(readFileSync(archive).length > 0);
  }
  assert.ok(!readdirSync(f.dir).some((name) => name.endsWith(".lock")));
});

test("archive, manifest, checksum and directory sync precede publication/pruning; any sync error refuses", async (t) => {
  for (const failure of [
    null,
    "archive",
    "manifest",
    "checksum",
    "directory",
  ]) {
    const f = await fixture(t);
    const order = [];
    const env = {
      DATABASE_URL: f.env.DATABASE_URL,
      BACKUP_DIR: f.dir,
      BACKUP_RUNTIME_ROLE: "meridian_login",
      BACKUP_KEEP: "1",
    };
    const sync = (stage) => {
      order.push(stage);
      if (stage === failure) throw new Error(`sync failed: ${stage}`);
    };
    const action = backup(env, {
      snapshot: async (_url, use) => {
        order.push("snapshot");
        return use(baseline());
      },
      run: (command, _args, options) => {
        if (command === "pg_dump") {
          order.push("dump");
          writeFileSync(options.stdio[1], "durable archive");
        } else order.push("toc");
        return { status: 0, stdout: "1; archive entry\n" };
      },
      syncFile: (fd, file) => {
        sync(
          file.endsWith(".dump")
            ? "archive"
            : file.endsWith(".json")
              ? "manifest"
              : "checksum",
        );
        fsyncSync(fd);
      },
      syncDirectory: (dir) => {
        sync("directory");
        fixtureDirectorySync(dir);
      },
      query: (_url, sql) => {
        order.push(
          sql.includes("last_failed_at") ? "failure-heartbeat" : "heartbeat",
        );
        assert.ok(
          readdirSync(f.dir).includes(f.saved.manifest.archive.file),
          "pruning occurred before publication",
        );
      },
      log: () => {},
    });
    if (failure) {
      await assert.rejects(action, new RegExp(`sync failed: ${failure}`));
      assert.ok(!order.includes("heartbeat"));
      assert.equal(order.at(-1), "failure-heartbeat");
      assert.ok(readdirSync(f.dir).includes(f.saved.manifest.archive.file));
    } else {
      const saved = await action;
      assert.deepEqual(order, [
        "snapshot",
        "dump",
        "archive",
        "toc",
        "manifest",
        "checksum",
        "directory",
        "heartbeat",
      ]);
      assert.ok(readdirSync(f.dir).includes(saved.manifest.archive.file));
      assert.ok(!readdirSync(f.dir).includes(f.saved.manifest.archive.file));
    }
    assert.ok(!readdirSync(f.dir).some((file) => file.endsWith(".lock")));
  }
});

test("directory fsync implementation never suppresses unsupported filesystem errors", (t) => {
  const dir = temp(t);
  if (process.platform === "win32")
    assert.throws(() => syncBackupDirectory(dir), /directory fsync failed/);
  else assert.doesNotThrow(() => syncBackupDirectory(dir));
});

test("extension availability/default mismatch refuses before creation; restored mismatch never records success", async (t) => {
  const f = await fixture(t);
  for (const kind of [
    "missing",
    "unavailable",
    "default",
    "restored version",
    "restored extra",
  ]) {
    f.calls.length = 0;
    await assert.rejects(
      restoreDrill(f.env, {
        ...f.deps,
        query: (url, sql) => {
          if (
            sql.includes("FROM pg_available_extensions") &&
            ["missing", "unavailable", "default"].includes(kind)
          ) {
            const entries = f.snapshot.extensions.map((e) => ({
              name: e.name,
              defaultVersion: e.version,
              versions: [e.version],
            }));
            if (kind === "missing") entries.pop();
            else if (kind === "unavailable") entries[1].versions = ["0.8.6"];
            else entries[1].defaultVersion = "0.8.6";
            return JSON.stringify(entries);
          }
          if (
            sql.includes("FROM pg_extension") &&
            kind.startsWith("restored")
          ) {
            const entries = structuredClone(f.snapshot.extensions);
            if (kind === "restored version") entries[1].version = "0.8.6";
            else
              entries.push({
                name: "unreviewed",
                version: "1",
                schema: "public",
              });
            return JSON.stringify(entries);
          }
          return f.deps.query(url, sql);
        },
      }),
      /extension/,
    );
    if (!kind.startsWith("restored"))
      assert.ok(!f.calls.some((c) => c.sql?.startsWith("CREATE DATABASE")));
  }
  assert.equal(
    f.heartbeats.filter((sql) => sql.includes("last_succeeded_at")).length,
    1,
  );
  assert.equal(
    f.heartbeats.filter((sql) => sql.includes("last_failed_at")).length,
    2,
  );
});

test("incoming membership, grantor and option drift refuse before database creation", async (t) => {
  const f = await fixture(t);
  for (const change of [
    (value) => {
      value.memberships = [];
    },
    (value) => {
      value.memberships[0].grantor = "meridian_app";
    },
    (value) => {
      value.memberships[0].admin_option = true;
    },
    (value) => {
      value.memberships[0].inherit_option = true;
    },
    (value) => {
      value.memberships[0].set_option = false;
    },
    (value) => {
      value.runtimeLogin.canSetRole = false;
    },
  ]) {
    f.calls.length = 0;
    const changed = structuredClone(f.snapshot);
    change(changed);
    await assert.rejects(
      restoreDrill(f.env, {
        ...f.deps,
        query: (url, sql) =>
          sql.startsWith("WITH RECURSIVE")
            ? JSON.stringify(changed)
            : f.deps.query(url, sql),
      }),
      /prerequisites differ|capability differs/,
    );
    assert.ok(!f.calls.some((c) => c.sql?.startsWith("CREATE DATABASE")));
  }
  await assert.rejects(
    restoreDrill(f.env, {
      ...f.deps,
      query: (url, sql) => {
        if (sql.includes("SET LOCAL SESSION AUTHORIZATION"))
          throw new Error("runtime SET ROLE denied");
        return f.deps.query(url, sql);
      },
    }),
    /runtime SET ROLE denied/,
  );
  assert.equal(
    f.heartbeats.filter((sql) => sql.includes("last_succeeded_at")).length,
    1,
  );
  assert.equal(
    f.heartbeats.filter((sql) => sql.includes("last_failed_at")).length,
    1,
  );
});

test("recursive runtime membership paths require SET on every edge, not superuser shortcuts", async (t) => {
  const b = baseline();
  b.roles.push({ ...runtimeRole, rolname: "runtime_group" });
  b.memberships[0].member = "runtime_group";
  b.memberships.push({
    ...b.memberships[0],
    role: "runtime_group",
    member: "meridian_login",
  });
  assert.doesNotThrow(() => assertPrerequisites(b));
  b.memberships[1].set_option = false;
  assert.throws(() => assertPrerequisites(b), /no SET-enabled/);
  b.memberships[1].set_option = true;
  b.roles.find((r) => r.rolname === "meridian_login").rolsuper = true;
  assert.throws(() => assertPrerequisites(b), /non-superuser login/);
  assert.match(
    rolePrerequisitesSql("meridian_login"),
    /m.roleid=c.oid OR m.member=c.oid/,
  );
  assert.match(
    rolePrerequisitesSql("meridian_login"),
    /SELECT grantor FROM edges/,
  );
  assert.match(
    rolePrerequisitesSql("meridian_login"),
    /classid='pg_database'::regclass/,
  );
  assert.match(
    rolePrerequisitesSql("meridian_login"),
    /SELECT setrole FROM pg_db_role_setting/,
  );
  assert.ok(
    rolePrerequisitesSql("meridian_login", [
      "quoted'\\role",
      "meridian_login",
      "meridian_app",
    ]).includes("E'quoted''\\\\role'"),
  );
  let captured = false;
  await assert.rejects(
    backup(
      { DATABASE_URL: "postgresql://localhost/source", BACKUP_DIR: temp(t) },
      {
        snapshot: () => {
          captured = true;
        },
      },
    ),
    /BACKUP_RUNTIME_ROLE/,
  );
  assert.equal(captured, false);
});

test("format 2 hashes extension and membership evidence and rejects legacy manifests", async (t) => {
  const f = await fixture(t);
  assert.equal(f.saved.manifest.format, 2);
  for (const mutate of [
    (m) => {
      m.extensions[1].version = "0.8.6";
    },
    (m) => {
      m.memberships[0].inherit_option = true;
    },
    (m) => {
      m.roles[1].rolbypassrls = false;
    },
    (m) => {
      m.databaseProperties.settings[0].value = "changed";
    },
  ]) {
    const changed = structuredClone(f.saved.manifest);
    mutate(changed);
    assert.notEqual(snapshotDigest(changed), f.saved.manifest.snapshotSha256);
    const bytes = JSON.stringify(changed);
    writeFileSync(f.saved.manifestFile, bytes);
    assert.throws(
      () => loadBackupManifest(f.saved.manifestFile, sha256(bytes)),
      /snapshot digest/,
    );
  }
  const legacy = JSON.stringify({ ...f.saved.manifest, format: 1 });
  writeFileSync(f.saved.manifestFile, legacy);
  assert.throws(
    () => loadBackupManifest(f.saved.manifestFile, sha256(legacy)),
    /format 2/,
  );
});

test("backup and restore clients receive password-free argv and private child environment credentials", async (t) => {
  const f = await fixture(
    t,
    "postgresql://runtime:source-secret@localhost/source",
  );
  const dump = f.producerCalls.find((call) => call.command === "pg_dump");
  assert.doesNotMatch(JSON.stringify(dump.args), /source-secret/);
  assert.equal(dump.options.env.PGPASSWORD, "source-secret");
  f.env.DRILL_DATABASE_URL =
    "postgresql://admin:target-secret@localhost/meridian_drill_test";
  await restoreDrill(f.env, f.deps);
  const restore = f.calls.find(
    (call) => call.command === "pg_restore" && call.args.includes("--dbname"),
  );
  assert.doesNotMatch(
    JSON.stringify(restore.args),
    /target-secret|source-secret/,
  );
  assert.equal(restore.options.env.PGPASSWORD, "target-secret");
});

test("database creation, ACL and settings drift fail before evidence; scratch creation uses template0", async (t) => {
  const f = await fixture(t);
  for (const kind of ["owner", "encoding", "collation", "acl", "settings"]) {
    f.calls.length = 0;
    const properties = {
      ...structuredClone(f.snapshot.databaseProperties),
      database: "meridian_drill_test",
    };
    if (kind === "owner") {
      properties.owner = "different_owner";
      properties.acl = properties.acl.map((entry) => ({
        ...entry,
        grantor: "different_owner",
        grantee: "different_owner",
      }));
    }
    if (kind === "encoding") properties.encoding = "LATIN1";
    if (kind === "collation") {
      properties.collationVersion = "different";
      properties.actualCollationVersion = "different";
    }
    if (kind === "acl")
      properties.acl.push({
        grantor: "owner",
        grantee: null,
        privilege: "CONNECT",
        grantable: false,
      });
    if (kind === "settings") properties.settings[0].value = "wrong";
    await assert.rejects(
      restoreDrill(f.env, {
        ...f.deps,
        query: (url, sql) =>
          sql.includes("'localeProvider'")
            ? JSON.stringify(properties)
            : f.deps.query(url, sql),
      }),
      /restored database .* differs/,
    );
    const creation = f.calls.find((call) =>
      call.sql?.startsWith("CREATE DATABASE"),
    );
    assert.match(
      creation.sql,
      /CREATE DATABASE "meridian_drill_test" WITH OWNER "owner" TEMPLATE template0/,
    );
    const restored = f.calls.some(
      (call) =>
        call.command === "pg_restore" && call.args.includes("--exit-on-error"),
    );
    assert.equal(restored, ["acl", "settings"].includes(kind));
    assert.ok(!f.calls.some((call) => call.args?.includes("--create")));
  }
  assert.equal(
    f.heartbeats.filter((sql) => sql.includes("last_succeeded_at")).length,
    1,
  );
  assert.equal(
    f.heartbeats.filter((sql) => sql.includes("last_failed_at")).length,
    2,
  );
});

test("database ACL/settings roles cannot be omitted from the hashed role prerequisites", async (t) => {
  const f = await fixture(t);
  for (const kind of ["acl", "settings"]) {
    const manifest = structuredClone(f.saved.manifest);
    if (kind === "acl")
      manifest.databaseProperties.acl.push({
        grantor: "owner",
        grantee: "missing_login",
        privilege: "CONNECT",
        grantable: false,
      });
    else
      manifest.databaseProperties.settings.push({
        role: "missing_login",
        name: "application_name",
        value: "fixture",
      });
    manifest.snapshotSha256 = snapshotDigest(manifest);
    const bytes = JSON.stringify(manifest);
    writeFileSync(f.saved.manifestFile, bytes);
    assert.throws(
      () => loadBackupManifest(f.saved.manifestFile, sha256(bytes)),
      /database ACL\/settings role missing/,
    );
  }
});

// Model only the SQL assignments asserted below; no PostgreSQL connection is used.
function heartbeatLedger(key, metadata) {
  let clock = Date.now();
  const row = {
    lastSucceededAt: new Date(clock),
    lastFailedAt: null,
    lastError: null,
    metadata,
  };
  const queries = [];
  const query = (_url, sql) => {
    queries.push(sql);
    clock = Math.max(clock + 1, Date.now());
    const timestamp = new Date(clock);
    if (sql.includes("last_failed_at")) {
      assert.match(
        sql,
        /INSERT INTO operational_heartbeats \(key,last_failed_at,last_error,updated_at\)/,
      );
      assert.match(
        sql,
        /DO UPDATE SET last_failed_at=excluded.last_failed_at,\s*last_error=excluded.last_error,updated_at=now()/,
      );
      assert.doesNotMatch(
        sql,
        /last_succeeded_at|last_started_at|metadata\s*=/,
      );
      if (key === "backup") {
        assert.match(
          sql,
          /WHERE operational_heartbeats.metadata->>'createdAt' IS NULL/,
        );
        const failedSnapshot = sql.match(/<= '([^']+)'::timestamptz/)[1];
        if (
          row.metadata?.createdAt &&
          Date.parse(row.metadata.createdAt) > Date.parse(failedSnapshot)
        )
          return;
      }
      row.lastFailedAt = timestamp;
      row.lastError = `${key}_run_failed`;
    } else {
      assert.match(
        sql,
        /last_succeeded_at=excluded.last_succeeded_at,\s*last_error=NULL,metadata=excluded.metadata/,
      );
      const encoded = sql.match(/decode\('([^']+)','base64'\)/)[1];
      row.metadata = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
      row.lastSucceededAt = timestamp;
      row.lastError = null;
    }
  };
  const readiness = () =>
    heartbeatCheck(
      key,
      key,
      row.lastSucceededAt,
      26 * 3600_000,
      true,
      clock,
      row,
    );
  return { row, queries, query, readiness };
}

test("actual backup failure is not green: preserve successful evidence, sanitize failure, recover on later success", async (t) => {
  const f = await fixture(
    t,
    "postgresql://runtime:private-source-password@localhost/source",
  );
  const ledger = heartbeatLedger("backup", f.saved.metadata);
  const previous = structuredClone(ledger.row);
  assert.equal(ledger.readiness().status, "pass");
  const env = {
    DATABASE_URL: f.env.DATABASE_URL,
    BACKUP_DIR: f.dir,
    BACKUP_RUNTIME_ROLE: "meridian_login",
  };
  const failure = new Error(
    "dump exploded at C:/private/backup.dump with private-source-password",
  );
  await assert.rejects(
    backup(env, {
      snapshot: async (_url, use) => use(baseline()),
      run: () => {
        throw failure;
      },
      query: ledger.query,
      log: () => {},
    }),
    (error) => {
      assert.match(error.message, /dump exploded/);
      assert.doesNotMatch(error.message, /private-source-password/);
      return true;
    },
  );
  assert.deepEqual(ledger.row.lastSucceededAt, previous.lastSucceededAt);
  assert.deepEqual(ledger.row.metadata, previous.metadata);
  assert.equal(ledger.row.lastError, "backup_run_failed");
  assert.equal(ledger.readiness().detail.evidenceState, "failed");
  assert.equal(ledger.readiness().status, "blocked");
  assert.doesNotMatch(
    ledger.queries.join("\n"),
    /dump exploded|private-source-password|private\/backup|postgresql:/,
  );
  const failedAt = ledger.row.lastFailedAt;
  await backup(env, {
    snapshot: async (_url, use) => use(baseline()),
    run: (command, _args, options) => {
      if (command === "pg_dump")
        writeFileSync(options.stdio[1], "recovered archive");
      return { status: 0, stdout: "1; archive entry\n" };
    },
    syncDirectory: fixtureDirectorySync,
    query: ledger.query,
    log: () => {},
  });
  assert.equal(ledger.row.lastError, null);
  assert.deepEqual(ledger.row.lastFailedAt, failedAt);
  assert.equal(ledger.readiness().status, "pass");
});

test("actual restore failure preserves last success and provenance; later verified restore clears the failure", async (t) => {
  const f = await fixture(t);
  const prior = await restoreDrill(f.env, f.deps);
  const ledger = heartbeatLedger("restore_drill", prior);
  const previous = structuredClone(ledger.row);
  const query = (url, sql) =>
    sql.includes("INSERT INTO operational_heartbeats")
      ? ledger.query(url, sql)
      : f.deps.query(url, sql);
  await assert.rejects(
    restoreDrill(f.env, {
      ...f.deps,
      query,
      run: (command, args, options) => {
        if (args.includes("--exit-on-error"))
          throw new Error(
            "restore exploded at /private/backup.dump with private-credential",
          );
        return f.deps.run(command, args, options);
      },
    }),
    /restore exploded/,
  );
  assert.deepEqual(ledger.row.lastSucceededAt, previous.lastSucceededAt);
  assert.deepEqual(ledger.row.metadata, previous.metadata);
  assert.equal(ledger.row.lastError, "restore_drill_run_failed");
  assert.equal(ledger.readiness().detail.evidenceState, "failed");
  assert.equal(ledger.readiness().status, "blocked");
  assert.doesNotMatch(
    ledger.queries.join("\n"),
    /exploded|private|backup.dump|postgresql:/,
  );
  await restoreDrill(f.env, { ...f.deps, query });
  assert.equal(ledger.row.lastError, null);
  assert.equal(ledger.readiness().status, "pass");
});

test("failure reporting errors never replace the original backup or restore error", async (t) => {
  const f = await fixture(t);
  const original = new Error("original operation failure");
  let failedReports = 0;
  const unavailable = (_url, sql) => {
    assert.match(sql, /last_failed_at/);
    failedReports++;
    throw new Error(
      "private reporting failure with /private/path and credential",
    );
  };
  await assert.rejects(
    backup(
      {
        DATABASE_URL: f.env.DATABASE_URL,
        BACKUP_DIR: f.dir,
        BACKUP_RUNTIME_ROLE: "meridian_login",
      },
      {
        snapshot: async (_url, use) => use(baseline()),
        run: () => {
          throw original;
        },
        query: unavailable,
        log: () => {},
      },
    ),
    { message: original.message },
  );
  await assert.rejects(
    restoreDrill(f.env, {
      ...f.deps,
      run: (command, args, options) => {
        if (args.includes("--exit-on-error")) throw original;
        return f.deps.run(command, args, options);
      },
      query: (url, sql) =>
        sql.includes("INSERT INTO operational_heartbeats")
          ? unavailable(url, sql)
          : f.deps.query(url, sql),
    }),
    { message: original.message },
  );
  assert.equal(failedReports, 2);
});

test("invalid backup configuration and snapshot preflight never write a heartbeat", async (t) => {
  const env = {
    DATABASE_URL: "postgresql://localhost/source",
    BACKUP_DIR: temp(t),
    BACKUP_RUNTIME_ROLE: "meridian_login",
  };
  let writes = 0;
  let dumps = 0;
  const deps = {
    query: () => {
      writes++;
    },
    log: () => {},
    run: () => {
      dumps++;
    },
    snapshot: async (_url, use) => use(baseline()),
  };
  for (const changes of [
    { DATABASE_URL: undefined },
    { DATABASE_URL: "invalid" },
    { BACKUP_RUNTIME_ROLE: undefined },
    { BACKUP_KEEP: "0" },
    { BACKUP_DIR: "relative-private-directory" },
  ])
    await assert.rejects(backup({ ...env, ...changes }, deps));
  await assert.rejects(
    backup(env, {
      ...deps,
      snapshot: () => {
        throw new Error("preflight refused");
      },
    }),
    /preflight refused/,
  );
  await assert.rejects(
    backup(env, {
      ...deps,
      snapshot: async (_url, use) =>
        use({
          ...baseline(),
          runtimeLogin: { name: "incorrect_login", canSetRole: false },
        }),
    }),
  );
  assert.equal(writes, 0);
  assert.equal(dumps, 0);
});

test("failure helper accepts only closed operation keys, uses bounded SQL and preserves newer snapshot evidence", () => {
  const metadata = { createdAt: new Date().toISOString() };
  const ledger = heartbeatLedger("backup", metadata);
  const previous = structuredClone(ledger.row);
  recordRecoveryFailure(
    "injected-only",
    "backup",
    ledger.query,
    new Date(Date.now() - 60_000).toISOString(),
  );
  assert.deepEqual(ledger.row, previous);
  const sql = ledger.queries[0];
  assert.match(sql, /statement_timeout = '3s'/);
  assert.match(sql, /lock_timeout = '1s'/);
  assert.match(sql, /SET LOCAL ROLE meridian_app/);
  assert.match(sql, /set_config\('app.bypass', 'on', true\)/);
  assert.match(sql, /'backup_run_failed'/);
  let writes = 0;
  for (const key of [
    "scheduled_work",
    "backup'; DROP TABLE operational_heartbeats; --",
  ])
    assert.equal(
      recordRecoveryFailure("injected-only", key, () => {
        writes++;
      }),
      false,
    );
  assert.equal(
    recordRecoveryFailure(
      "injected-only",
      "backup",
      () => {
        writes++;
      },
      "invalid-date",
    ),
    false,
  );
  assert.equal(writes, 0);
});
