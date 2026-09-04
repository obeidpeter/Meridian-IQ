import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export interface WebAppDefaults {
  basePath: string;
  port: number;
}

export interface WebAppEnvironment {
  basePath: string;
  port: number;
}

function validBasePath(value: string): boolean {
  return value.startsWith("/") && value.endsWith("/") && !value.includes("?");
}

/** Resolve deployment overrides without making local builds environment-bound. */
export function resolveWebAppEnvironment(
  defaults: WebAppDefaults,
  env: NodeJS.ProcessEnv = process.env,
): WebAppEnvironment {
  const rawPort = env.PORT ?? String(defaults.port);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const basePath = env.BASE_PATH ?? defaults.basePath;
  if (!validBasePath(basePath)) {
    throw new Error(
      `Invalid BASE_PATH value: "${basePath}". Expected an absolute path ending in /.`,
    );
  }

  return { basePath, port };
}

/**
 * The one Vite config for the five web apps (landing, console, SME, buyer
 * portal, penalty calculator). Each app's vite.config.ts calls
 * this with its own directory:
 *
 *   export default webAppViteConfig(import.meta.dirname, {
 *     basePath: "/console/",
 *     port: 3001,
 *   });
 *
 * Checked-in defaults make a clean checkout buildable. Replit/deployment
 * workflows can override either value through PORT and BASE_PATH.
 */
export async function webAppViteConfig(
  appDir: string,
  defaults: WebAppDefaults,
): Promise<UserConfig> {
  const { basePath, port } = resolveWebAppEnvironment(defaults);

  // Clickjacking defence (SEC-02). The session cookie is SameSite=None so the
  // apps work inside the Replit preview iframe, which re-opens framing; a CSP
  // frame-ancestors allowlist blocks arbitrary attacker origins while keeping the
  // legitimate embedders. X-Frame-Options is intentionally NOT used — it cannot
  // express a cross-origin allowlist, so it would break the preview embedding.
  // Override the allowlist per deployment with the FRAME_ANCESTORS env var.
  const frameAncestors =
    process.env.FRAME_ANCESTORS ??
    "'self' https://*.replit.dev https://*.replit.app https://*.replit.com https://replit.com";
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https: wss:",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");

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
        "Content-Security-Policy": `${contentSecurityPolicy};`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy":
          "camera=(), geolocation=(), microphone=(self), payment=()",
      },
    },
  });
}
