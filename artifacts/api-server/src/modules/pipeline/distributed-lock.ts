import {
  asDatabaseConnectionError,
  isDatabaseConnectionError,
  type PoolClient,
  workerLockPool,
} from "@workspace/db";
import { logger } from "../../lib/logger";

// The worker's distributed pass lock (R107: extracted from pipeline.ts). A
// pass — sweeps, reconcile — runs on exactly one instance at a time; the lock
// is session-level on the dedicated worker pool, and a session whose unlock
// failed is destroyed rather than returned to the pool, so a stranded lock
// can never block every later pass.
/** Run `task` under a session-level advisory lock on the worker pool; the
 *  pass is skipped (acquired: false) when another instance holds it.
 *  `onConnectionLost` is the ownership-failure policy: losing the session
 *  means the lock is gone, so the caller pauses scheduling. If a task is
 *  already running, it is passed to that policy as an unsettled fence: the
 *  caller must not resume this process while that task can still side-effect. */
export async function withDistributedLock<T>(
  lockId: number,
  task: () => Promise<T>,
  onConnectionLost: (activeWork?: PromiseLike<unknown>) => void,
): Promise<{ acquired: boolean; value?: T }> {
  let client: PoolClient;
  try {
    client = await workerLockPool.connect();
  } catch (error) {
    // No advisory lock can exist without a session. Treat a connection failure
    // during pool acquisition as ownership loss too, so callers enter the same
    // bounded recovery window.
    if (isDatabaseConnectionError(error)) {
      onConnectionLost();
      throw asDatabaseConnectionError(error);
    }
    throw error;
  }
  let acquired = false;
  let taskError: unknown;
  let releaseError: Error | undefined;
  let taskPromise: Promise<T> | undefined;
  let taskSettled = false;
  const onConnectionError = (error: Error) => {
    releaseError = error;
    // Losing a session lock is an ownership failure. Pause scheduling and ask
    // cooperative work to stop. An unsettled task is not safe to resume over:
    // it may still perform a side effect after another worker acquires the lock.
    onConnectionLost(taskSettled ? undefined : taskPromise);
    logger.error(
      { lockId },
      "worker lock connection lost; worker scheduling paused",
    );
  };
  client.on("error", onConnectionError);
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [lockId],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return { acquired: false };
    taskPromise = Promise.resolve().then(task);
    taskPromise.then(
      () => {
        taskSettled = true;
      },
      () => {
        taskSettled = true;
      },
    );
    return { acquired: true, value: await taskPromise };
  } catch (error) {
    taskError = error;
    throw taskPromise === undefined && isDatabaseConnectionError(error)
      ? asDatabaseConnectionError(error)
      : error;
  } finally {
    if (acquired) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1) AS unlocked",
          [lockId],
        );
        if (result.rows[0]?.unlocked !== true) {
          throw new Error("Pipeline advisory lock was not held at release");
        }
      } catch (error) {
        releaseError =
          error instanceof Error ? error : new Error(String(error));
        logger.error({ err: releaseError, lockId }, "advisory unlock failed");
      }
    }
    // Destroy a session whose unlock failed so a session-level lock cannot be
    // returned to the pool and strand all future sweep attempts.
    client.removeListener("error", onConnectionError);
    client.release(releaseError);
    if (!taskError && releaseError) {
      throw isDatabaseConnectionError(releaseError)
        ? asDatabaseConnectionError(releaseError)
        : releaseError;
    }
  }
}
