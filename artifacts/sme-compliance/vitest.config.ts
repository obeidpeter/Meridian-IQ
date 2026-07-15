import { webAppVitestConfig } from "@workspace/web-config/vitest";

// Standalone so vitest does not auto-load vite.config.ts (which throws when
// PORT / BASE_PATH are unset) — shared shape in lib/web-config.
export default webAppVitestConfig(import.meta.dirname);
