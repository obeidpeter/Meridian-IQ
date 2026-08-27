import { describe, expect, test } from "vitest";
import { resolveQuerySecret } from "./query-secret";

describe("resolveQuerySecret", () => {
  test("takes the token from the fragment and strips it from the shown URL", () => {
    const r = resolveQuerySecret("token", "https://x.example/reset-password#token=abc", null);
    expect(r.value).toBe("abc");
    expect(r.stash).toBe("abc");
    expect(r.cleanedUrl).toBe("/reset-password");
  });
  test("takes the token from the query string, keeping other params", () => {
    const r = resolveQuerySecret("token", "https://x.example/accept-invite?token=abc&x=1", null);
    expect(r.value).toBe("abc");
    expect(r.cleanedUrl).toBe("/accept-invite?x=1");
  });
  test("falls back to the tab stash when the URL carries no token (refresh)", () => {
    const r = resolveQuerySecret("token", "https://x.example/reset-password", "abc");
    expect(r.value).toBe("abc");
    expect(r.cleanedUrl).toBeNull();
    expect(r.stash).toBeNull();
  });
  test("returns null with no token and no stash", () => {
    const r = resolveQuerySecret("token", "https://x.example/reset-password", null);
    expect(r.value).toBeNull();
    expect(r.cleanedUrl).toBeNull();
  });
});
