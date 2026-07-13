import type { AddressInfo } from "node:net";
import express from "express";
import { errorHandler } from "../middleware/error.ts";
import type { Principal } from "../modules/auth/rbac.ts";

// Shared express route-test harness: build an app with a principal-injection
// middleware and the standard error handler, start it on an ephemeral port,
// and close every started server in after() via closeAllServers(). Module
// state is per-file because node:test runs one process per file.

export const JSON_HEADERS = { "content-type": "application/json" };

export function appFor(principal: Principal, router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = principal;
    req.log = {
      warn: () => {},
      error: () => {},
      info: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use(router);
  app.use(errorHandler);
  return app;
}

const closers: Array<() => Promise<void>> = [];

export async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
  return `http://127.0.0.1:${port}`;
}

export async function closeAllServers(): Promise<void> {
  await Promise.all(closers.map((c) => c()));
}
