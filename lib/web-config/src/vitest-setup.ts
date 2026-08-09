import { afterEach } from "vitest";

// Component tests run in jsdom, where history.replaceState mutates a URL
// shared by every test in the file. Anything exercising URL-backed state
// (useUrlTab's ?view= / ?status= parameters) would otherwise leak its query
// string into the next test's initial render. Typed via globalThis because
// this package compiles without the DOM lib — the node-environment tests
// simply have no history to reset.
afterEach(() => {
  const g = globalThis as {
    history?: { replaceState(data: unknown, unused: string, url: string): void };
    location?: { pathname: string };
  };
  if (g.history && g.location) {
    g.history.replaceState(null, "", g.location.pathname);
  }
});
