import { describe, expect, it } from "vitest";
import { resolveWebAppEnvironment } from "./index";

const defaults = { basePath: "/console/", port: 3001 };

describe("resolveWebAppEnvironment", () => {
  it("uses checked-in defaults for a clean local build", () => {
    expect(resolveWebAppEnvironment(defaults, {})).toEqual(defaults);
  });

  it("honours valid deployment overrides", () => {
    expect(
      resolveWebAppEnvironment(defaults, {
        PORT: "18115",
        BASE_PATH: "/admin/",
      }),
    ).toEqual({ basePath: "/admin/", port: 18115 });
  });

  it.each([
    [{ PORT: "0" }, "PORT"],
    [{ PORT: "not-a-port" }, "PORT"],
    [{ BASE_PATH: "console" }, "BASE_PATH"],
    [{ BASE_PATH: "/console" }, "BASE_PATH"],
  ])("rejects invalid overrides", (env, expected) => {
    expect(() => resolveWebAppEnvironment(defaults, env)).toThrow(expected);
  });
});
