import { defineConfig } from "vitest/config";
import path from "path";

// Standalone test config. It exists so vitest does NOT auto-load vite.config.ts,
// which throws at eval time when PORT / BASE_PATH are unset (the dev/build
// contract). The unit tests here are pure and DOM-free, so the default node
// environment is enough — no jsdom. The `@` alias mirrors vite.config.ts /
// tsconfig for any test that imports via the alias.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
