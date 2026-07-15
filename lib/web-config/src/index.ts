import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

/**
 * The one vite config for the four web apps (landing, console, SME, buyer
 * portal) — they were byte-identical copies. Each app's vite.config.ts calls
 * this with its own directory:
 *
 *   export default webAppViteConfig(import.meta.dirname);
 *
 * PORT and BASE_PATH are required (the dev/build contract): the per-app build
 * commands set them, and failing loudly here beats silently serving the wrong
 * base path behind the path-router.
 */
export async function webAppViteConfig(appDir: string): Promise<UserConfig> {
  const rawPort = process.env.PORT;

  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const basePath = process.env.BASE_PATH;

  if (!basePath) {
    throw new Error(
      "BASE_PATH environment variable is required but was not provided.",
    );
  }

  // Clickjacking defence (SEC-02). The session cookie is SameSite=None so the
  // apps work inside the Replit preview iframe, which re-opens framing; a CSP
  // frame-ancestors allowlist blocks arbitrary attacker origins while keeping the
  // legitimate embedders. X-Frame-Options is intentionally NOT used — it cannot
  // express a cross-origin allowlist, so it would break the preview embedding.
  // Override the allowlist per deployment with the FRAME_ANCESTORS env var.
  const frameAncestors =
    process.env.FRAME_ANCESTORS ??
    "'self' https://*.replit.dev https://*.replit.app https://*.replit.com https://replit.com";

  return defineConfig({
    base: basePath,
    plugins: [
      react(),
      tailwindcss(),
      runtimeErrorOverlay(),
      ...(process.env.NODE_ENV !== "production" &&
      process.env.REPL_ID !== undefined
        ? [
            await import("@replit/vite-plugin-cartographer").then((m) =>
              m.cartographer({
                root: path.resolve(appDir, ".."),
              }),
            ),
            await import("@replit/vite-plugin-dev-banner").then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(appDir, "src"),
        "@assets": path.resolve(appDir, "..", "..", "attached_assets"),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(appDir),
    build: {
      outDir: path.resolve(appDir, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
      headers: {
        "Content-Security-Policy": `frame-ancestors ${frameAncestors};`,
        "X-Content-Type-Options": "nosniff",
      },
    },
  });
}
