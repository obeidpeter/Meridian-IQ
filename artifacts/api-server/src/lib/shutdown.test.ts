import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGracefulShutdown, type ShutdownDeps } from "./shutdown.ts";

// Graceful shutdown (R101): the sequence, its order, its one-shot guard and
// its deadline — driven with fakes, plus a real child-process signal check.

function fakeDeps(over: Partial<ShutdownDeps> = {}) {
  const order: string[] = [];
  const exits: number[] = [];
  const deps: ShutdownDeps = {
    server: {
      close: (cb?: (err?: Error) => void) => {
        order.push("server.close");
        cb?.();
        return deps.server as never;
      },
      closeIdleConnections: () => order.push("server.closeIdleConnections"),
    },
    markUnready: (reason) => order.push(`markUnready:${reason}`),
    stopWorker: () => order.push("stopWorker"),
    awaitWorkerIdle: async () => {
      order.push("awaitWorkerIdle");
      return true;
    },
    closePool: async () => {
      order.push("closePool");
    },
    exit: (code) => {
      order.push(`exit:${code}`);
      exits.push(code);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    timeoutMs: 1_000,
    ...over,
  };
  return { deps, order, exits };
}

function runSignalShutdownChild(
  fatal: boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const script = `
    import { installGracefulShutdown } from "./src/lib/shutdown.ts";
    if (${String(fatal)}) {
      process.env.PIPELINE_HARD_STOP_ON_LOCK_LOSS = "0";
      process.exitCode = 1;
    }
    const server = {
      close(callback) { callback?.(); },
      closeIdleConnections() {},
    };
    installGracefulShutdown({
      server,
      markUnready() {},
      stopWorker() {},
      awaitWorkerIdle: async () => true,
      closePool: async () => {},
      exit: (code) => process.exit(code),
      log: { info() {}, warn() {}, error() {} },
      timeoutMs: 1_000,
    });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("readiness flips first, then the worker stops, the server drains, the pass settles, the pool closes, exit 0", async () => {
  const { deps, order, exits } = fakeDeps();
  const shutdown = createGracefulShutdown(deps);
  await shutdown("SIGTERM");
  assert.deepEqual(order, [
    "markUnready:shutting_down",
    "stopWorker",
    "server.close",
    "server.closeIdleConnections",
    "awaitWorkerIdle",
    "closePool",
    "exit:0",
  ]);
  assert.deepEqual(exits, [0]);
});

test("a second signal during shutdown is ignored; a pool-close failure still exits 0", async () => {
  const { deps, order, exits } = fakeDeps({
    closePool: async () => {
      throw new Error("pool already ended");
    },
  });
  const shutdown = createGracefulShutdown(deps);
  await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
  assert.equal(order.filter((o) => o === "stopWorker").length, 1, "one-shot");
  assert.deepEqual(exits, [0]);
});

test("the deadline forces exit 1 when a step hangs", async () => {
  const { deps, exits } = fakeDeps({
    timeoutMs: 40,
    awaitWorkerIdle: () => new Promise(() => {}),
  });
  const shutdown = createGracefulShutdown(deps);
  void shutdown("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(exits, [1], "the deadline fired");
});

test("a fatal SIGTERM keeps its nonzero exit, ordinary SIGTERM stays zero, and the old opt-out is gone", async () => {
  const pipelineSource = readFileSync(
    new URL("../modules/pipeline/pipeline.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    pipelineSource,
    /PIPELINE_HARD_STOP_ON_LOCK_LOSS/,
    "lock-loss termination cannot be disabled by the former environment flag",
  );
  assert.deepEqual(await runSignalShutdownChild(true), {
    code: 1,
    signal: null,
  });
  assert.deepEqual(await runSignalShutdownChild(false), {
    code: 0,
    signal: null,
  });
});
