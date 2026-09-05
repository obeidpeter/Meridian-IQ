import { describe, expect, test } from "vitest";
import { stableCommandKey } from "./idempotent-command";

describe("replay-safe command identity", () => {
  test("is stable across retries, reloads and object property order", async () => {
    const first = await stableCommandKey("firm:user:client:draft:create", {
      currency: "NGN",
      lines: [{ quantity: "1", unitPrice: "2" }],
    });
    const retry = await stableCommandKey("firm:user:client:draft:create", {
      lines: [{ unitPrice: "2", quantity: "1" }],
      currency: "NGN",
    });
    expect(first).toMatch(/^sme-[0-9a-f]{64}$/);
    expect(retry).toBe(first);
  });
  test("separates users, firms, clients, draft slots and changed commands", async () => {
    const base = await stableCommandKey("firm:user:client:one:create", {
      invoiceNumber: "1",
    });
    for (const scope of [
      "firm:other:client:one:create",
      "other:user:client:one:create",
      "firm:user:other:one:create",
      "firm:user:client:two:create",
    ]) {
      expect(await stableCommandKey(scope, { invoiceNumber: "1" })).not.toBe(
        base,
      );
    }
    expect(
      await stableCommandKey("firm:user:client:one:create", {
        invoiceNumber: "2",
      }),
    ).not.toBe(base);
  });
  test("unchanged import rows retain their key after a response loss", async () => {
    const payload = {
      commit: true,
      clientPartyId: "client",
      rows: [{ invoiceNumber: "1" }, { invoiceNumber: "2" }],
    };
    expect(await stableCommandKey("firm:user:client:import", payload)).toBe(
      await stableCommandKey(
        "firm:user:client:import",
        JSON.parse(JSON.stringify(payload)),
      ),
    );
    expect(await stableCommandKey("firm:user:client:import", payload)).not.toBe(
      await stableCommandKey("firm:user:client:import", {
        ...payload,
        rows: payload.rows.slice(1),
      }),
    );
  });
});
