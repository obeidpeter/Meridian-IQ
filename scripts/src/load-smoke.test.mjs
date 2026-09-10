import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { commandHeaders } from "./test-client.mjs";

test("command fixtures issue unique keys and preserve an explicit replay key", () => {
  const first = commandHeaders();
  assert.notEqual(
    commandHeaders()["x-idempotency-key"],
    first["x-idempotency-key"],
  );
  assert.deepEqual(commandHeaders(first["x-idempotency-key"]), first);
  assert.equal(first["x-valo-csrf"], "1");
});

async function probe(status) {
  let logins = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/api/auth/login") {
      logins++;
      if (
        req.headers["x-valo-csrf"] !== "1" ||
        req.headers["x-valo-client"] !== "mobile"
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ token: "synthetic-fixture-token" }));
    } else {
      res.writeHead(
        req.headers.authorization === "Bearer synthetic-fixture-token"
          ? status
          : 401,
      );
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./load-smoke.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          API_URL: `http://127.0.0.1:${server.address().port}`,
          DEMO_PASSWORD: "synthetic-test-password",
          LOAD_SMOKE_REQUESTS_PER_ROUTE: "2",
          LOAD_SMOKE_CONCURRENCY: "2",
          LOAD_SMOKE_P95_MS: "10000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
    return { code, output, logins };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("load-smoke logs in through CSRF and bearer contracts before measuring reads", async () => {
  const result = await probe(200);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.logins, 2);
  assert.match(result.output, /10 requests/);
});
test("load-smoke treats 429 as operational failure, never a latency success", async () => {
  const result = await probe(429);
  assert.equal(result.code, 2, result.output);
  assert.doesNotMatch(result.output, /OK/);
});
