import { defineConfig, type ViteUserConfig } from "vitest/config";
import path from "path";

/**
 * The standalone unit-test config shared by the web apps. It exists so vitest
 * does NOT auto-load vite.config.ts, which throws at eval time when PORT /
 * BASE_PATH are unset (the dev/build contract). The unit tests are pure and
 * default to the node environment — component tests opt into jsdom per file
 * with a `// @vitest-environment jsdom` docblock. The `@` alias mirrors
 * vite.config.ts / tsconfig for any test that imports via the alias.
 *
 *   export default webAppVitestConfig(import.meta.dirname);
 */
export function webAppVitestConfig(appDir: string): ViteUserConfig {
  return defineConfig({
    resolve: {
      alias: {
        "@": path.resolve(appDir, "src"),
      },
    },
    // The app tsconfigs use jsx: "preserve" (the vite react plugin owns the
    // transform in builds); tests transform through esbuild, which needs the
    // automatic runtime spelled out for .test.tsx files.
    esbuild: {
      jsx: "automatic",
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.{ts,tsx}"],
    },
  });
}
