import { afterEach } from "vitest";

// Component tests run in jsdom, where history.replaceState mutates a URL
// shared by every test in the file. Anything exercising URL-backed state
// (useUrlTab's ?view= / ?status= parameters) would otherwise leak its query
// string into the next test's initial render.
afterEach(() => {
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", window.location.pathname);
  }
});
