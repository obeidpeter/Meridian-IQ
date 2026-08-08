import { pool } from "@workspace/db";
import { DomainError } from "../modules/errors";

// A short session lock closes the gap between a durable local reservation and
// its external provider call. It spans instances but holds no DB transaction,
// and provider calls are independently capped at five seconds.
export async function withProviderOperationLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let acquired = false;
  let releaseError: Error | undefined;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [key],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) {
      throw new DomainError(
        "PROVIDER_OPERATION_IN_PROGRESS",
        "This provider operation is already in progress; retry shortly",
        409,
      );
    }
    return await task();
  } finally {
    if (acquired) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
          [key],
        );
        if (result.rows[0]?.unlocked !== true) {
          throw new Error("Provider advisory lock was not held at release");
        }
      } catch (error) {
        releaseError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
    // Passing an error destroys the pooled session. PostgreSQL then releases
    // any lock that could not be explicitly unlocked.
    client.release(releaseError);
  }
}
