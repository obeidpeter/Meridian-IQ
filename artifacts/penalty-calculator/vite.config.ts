import { webAppViteConfig } from "@workspace/web-config";

// The full config (PORT/BASE_PATH contract, SEC-02 frame-ancestors CSP,
// plugins, aliases) is shared by the four web apps — see lib/web-config.
export default webAppViteConfig(import.meta.dirname);
