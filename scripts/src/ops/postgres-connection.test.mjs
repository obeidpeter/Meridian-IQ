import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { postgresConnection, psql } from "./common.mjs";

test("PostgreSQL credentials move from URL arguments to child environment", () => {
  const raw =
    "postgresql://runtime:p%40ss%3Aword@db.example/source?sslmode=require";
  const connection = postgresConnection(raw, {
    PATH: "fixture",
    PGPASSWORD: "old",
  });
  assert.equal(
    connection.url,
    "postgresql://runtime@db.example/source?sslmode=require",
  );
  assert.equal(connection.env.PGPASSWORD, "p@ss:word");
  assert.equal(connection.env.PATH, "fixture");
  assert.doesNotMatch(
    connection.redact(`error ${raw} p@ss:word p%40ss%3Aword`),
    /p@ss|p%40ss/,
  );
  const output = psql(raw, "SELECT 1", (command, args, options) => {
    assert.equal(command, "psql");
    assert.deepEqual(args.slice(0, 2), ["--dbname", connection.url]);
    assert.deepEqual(args.slice(-2), ["-c", "SELECT 1"]);
    assert.ok(args.includes("-w"));
    assert.ok(args.includes(connection.url));
    assert.ok(!JSON.stringify(args).includes("p%40ss"));
    assert.equal(options.env.PGPASSWORD, "p@ss:word");
    return { status: 0, stdout: "1\n" };
  });
  assert.equal(output, "1");
});

test("password query overrides and malformed credentials refuse without leaking values", () => {
  for (const query of [
    "password=secret",
    "PASSWORD=secret",
    "pass%77ord=secret",
    "sslpassword=secret",
    "passfile=/private/file",
    "service=private",
  ]) {
    assert.throws(
      () => postgresConnection(`postgresql://user:secret@host/db?${query}`),
      (error) => {
        assert.doesNotMatch(error.message, /secret|private/);
        return true;
      },
    );
  }
  assert.throws(
    () => postgresConnection("postgresql://u:%ZZ@host/db"),
    /invalid PostgreSQL password encoding/,
  );
  assert.throws(
    () => postgresConnection("invalid-secret"),
    (error) => !error.message.includes("invalid-secret"),
  );
});

test("percent-encoded Unix-socket host survives password removal", () => {
  const socket = "%2Fhome%2Frunner%2F.meridian-dr-r198-20260905%2Fsocket";
  const connection = postgresConnection(
    `postgresql://runtime:secret@${socket}/meridian_drill_test`,
    {},
  );
  assert.equal(
    connection.url,
    `postgresql://runtime@${socket}/meridian_drill_test`,
  );
  assert.equal(connection.env.PGPASSWORD, "secret");
});

test("PostgreSQL spawn and server errors redact URL and environment passwords", () => {
  const raw = "postgresql://runtime:secret@host/source";
  for (const execute of [
    () => ({ status: 1, stderr: `failed ${raw} secret` }),
    () => {
      throw new Error(`spawn ${raw} secret`);
    },
  ])
    assert.throws(
      () => psql(raw, "SELECT 1", execute),
      (error) => {
        assert.match(error.message, /redacted/);
        assert.doesNotMatch(error.message, /secret/);
        assert.doesNotMatch(inspect(error, { depth: 8 }), /secret/);
        return true;
      },
    );
  const inherited = postgresConnection("postgresql://runtime@host/source", {
    PGPASSWORD: "inherited-secret",
  });
  assert.equal(inherited.env.PGPASSWORD, "inherited-secret");
  assert.doesNotMatch(inherited.redact("inherited-secret"), /inherited-secret/);
});
