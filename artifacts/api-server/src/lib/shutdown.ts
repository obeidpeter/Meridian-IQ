import type { Server } from "node:http";

// Graceful shutdown (R101). On SIGTERM/SIGINT the instance:
//   1. flips readiness OFF (so /api/readyz answers 503 and the load balancer
//      drains it) and stops the worker timers (no new passes);
//   2. stops accepting connections and lets in-flight requests finish
//      (idle keep-alive sockets are closed so server.close can complete);
//   3. waits for the worker pass that may be mid-transaction to settle;
//   4. closes the pool and exits 0.
// A deadline (SHUTDOWN_TIMEOUT_MS, default 25 s — under a typical 30 s
// orchestrator grace period) forces exit 1 if any step hangs. A second signal
// during shutdown is ignored: the sequence runs once.

export interface ShutdownDeps {
  server: Pick<Server, "close"> & { closeIdleConnections?: () => void };
  markUnready(reason: string): void;
  stopWorker(): void;
  awaitWorkerIdle(timeoutMs: number): Promise<boolean>;
  closePool(): Promise<void>;
  exit(code: number): void;
  log: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
  timeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

function shutdownTimeoutMs(): number {
  const configured = Number(process.env.SHUTDOWN_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

function closeServer(server: ShutdownDeps["server"]): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Keep-alive sockets with no request in flight would otherwise hold
    // close() open until the client hangs up.
    server.closeIdleConnections?.();
  });
}

/** Build the one-shot shutdown sequence; call it with the signal name. */
export function createGracefulShutdown(
  deps: ShutdownDeps,
): (signal: string) => Promise<void> {
  let started = false;
  return async (signal: string) => {
    if (started) {
      deps.log.info(
        { signal },
        "Shutdown already in progress; ignoring signal",
      );
      return;
    }
    started = true;
    // A fatal worker invariant may have set process.exitCode before sending
    // SIGTERM. Preserve it through the graceful drain instead of turning the
    // failed process into a successful one.
    const requestedExitCode =
      typeof process.exitCode === "number" ? process.exitCode : 0;
    const timeoutMs = deps.timeoutMs ?? shutdownTimeoutMs();
    const startedAt = Date.now();
    deps.log.info(
      { signal, timeoutMs },
      "Shutting down: readiness off, draining",
    );
    const deadline = setTimeout(() => {
      deps.log.error(
        { timeoutMs },
        "Shutdown deadline passed with work still in flight; exiting",
      );
      deps.exit(1);
    }, timeoutMs);
    deadline.unref?.();

    deps.markUnready("shutting_down");
    deps.stopWorker();
    await closeServer(deps.server);
    const idle = await deps.awaitWorkerIdle(
      Math.max(1, timeoutMs - (Date.now() - startedAt)),
    );
    if (!idle) {
      deps.log.warn(
        {},
        "A worker pass was still running at shutdown; exiting anyway",
      );
    }
    try {
      await deps.closePool();
    } catch (err) {
      deps.log.error({ err }, "Closing the database pool failed");
    }
    clearTimeout(deadline);
    deps.log.info({ tookMs: Date.now() - startedAt }, "Shutdown complete");
    deps.exit(requestedExitCode);
  };
}

/** Wire SIGTERM/SIGINT to the sequence once; returns the handler for tests. */
export function installGracefulShutdown(
  deps: ShutdownDeps,
): (signal: string) => Promise<void> {
  const shutdown = createGracefulShutdown(deps);
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}
