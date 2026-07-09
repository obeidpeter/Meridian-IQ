// Static path-router for the E2E harness: serves the four built frontends the
// way the production origin does (SPA fallback per prefix) and proxies /api to
// the api-server. No vite processes — the tests run against real builds.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

const APPS = [
  { prefix: "/console", dir: "artifacts/console/dist/public" },
  { prefix: "/app", dir: "artifacts/sme-compliance/dist/public" },
  { prefix: "/buyer", dir: "artifacts/buyer-portal/dist/public" },
  { prefix: "", dir: "artifacts/landing/dist/public" }, // catch-all: portal at "/"
];

export function startStaticServer({ port, apiPort }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    // API proxy
    if (url.pathname.startsWith("/api")) {
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
        },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", (err) => {
        res.writeHead(502);
        res.end(String(err));
      });
      req.pipe(upstream);
      return;
    }

    const app = APPS.find(
      (a) =>
        a.prefix === "" ||
        url.pathname === a.prefix ||
        url.pathname.startsWith(a.prefix + "/"),
    );
    const rel = url.pathname.slice(app.prefix.length) || "/";
    const baseDir = path.join(ROOT, app.dir);
    let filePath = path.normalize(path.join(baseDir, rel));
    if (!filePath.startsWith(baseDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    // SPA fallback: anything without a file extension serves index.html
    if (!existsSync(filePath) || path.extname(filePath) === "") {
      filePath = path.join(baseDir, "index.html");
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, {
        "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
