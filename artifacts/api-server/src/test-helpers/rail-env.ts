// The rail transport resolves from the environment when nothing is bound
// (R95): a developer shell exporting RAIL_PRIMARY_URL would make every
// `setRailTransport(null)` in a DB suite resolve to the HTTP transport and
// dial a real access point. Suites that rely on the simulator as the unbound
// default clear these keys in before() and restore them in after().

export const RAIL_ENV_KEYS = [
  "RAIL_PRIMARY_URL",
  "RAIL_SECONDARY_URL",
  "RAIL_PRIMARY_TOKEN",
  "RAIL_SECONDARY_TOKEN",
  "RAIL_ENVIRONMENT",
  "RAIL_TIMEOUT_MS",
] as const;

/**
 * Delete every RAIL_* key from process.env and hand back a function that
 * puts the original values back (unset keys stay unset).
 */
export function clearRailEnv(): () => void {
  const saved = Object.fromEntries(
    RAIL_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof RAIL_ENV_KEYS)[number], string | undefined>;
  for (const key of RAIL_ENV_KEYS) delete process.env[key];
  return () => {
    for (const key of RAIL_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
