import assert from "node:assert/strict";
import test from "node:test";
import { currentCorrelationId, runCorrelationContext } from "./context.ts";

test("request correlation survives async work and restores the parent scope", async () => {
  assert.equal(currentCorrelationId(), null);

  await runCorrelationContext("request-parent", async () => {
    assert.equal(currentCorrelationId(), "request-parent");
    await Promise.resolve();
    assert.equal(currentCorrelationId(), "request-parent");

    runCorrelationContext("request-child", () => {
      assert.equal(currentCorrelationId(), "request-child");
    });

    assert.equal(currentCorrelationId(), "request-parent");
  });

  assert.equal(currentCorrelationId(), null);
});
