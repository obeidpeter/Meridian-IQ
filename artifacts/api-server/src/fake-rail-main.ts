import { startFakeRail } from "./modules/rails/fake-rail";

// CLI entry for the conformance fake rail (R95): the e2e harness spawns this
// so a whole run stamps over HTTP through a scriptable access point.
//
//   PORT=5199 FAKE_RAIL_TOKEN=secret pnpm --filter @workspace/api-server run fake-rail
//
// Prints one ready line to stdout and exits cleanly on SIGTERM/SIGINT.

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 5199);
  const token = process.env.FAKE_RAIL_TOKEN?.trim() || undefined;
  const rail = await startFakeRail({
    port: Number.isFinite(port) && port >= 0 ? port : 5199,
    token,
  });
  process.stdout.write(`fake rail listening on ${rail.url}\n`);
  const stop = (): void => {
    void rail.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`fake rail failed to start: ${String(err)}\n`);
  process.exit(1);
});
