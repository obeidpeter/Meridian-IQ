import { webAppVitestConfig } from "@workspace/web-config/vitest";

// Standalone so tests do not load the plugin-heavy application Vite config.
export default webAppVitestConfig(import.meta.dirname);
