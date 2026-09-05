import assert from "node:assert/strict";
import test from "node:test";
import {
  selectFirstInvoiceCustomer,
  waitForNewInvoiceDraft,
} from "./lifecycle.mjs";

const BASE = "http://127.0.0.1:8091";
const PATH = "/app/invoices/new";
const ID = "12345678-1234-4567-89ab-123456789abc";
const DRAFT_URL = `${BASE}${PATH}?draft=${ID}`;

function fixture(overrides = {}) {
  const calls = [];
  let waitCount = 0;
  const page = {
    async waitForURL(predicate, options) {
      const draftWait = waitCount++ === 1;
      calls.push(draftWait ? "draft identity" : "exact route");
      assert.deepEqual(options, { timeout: 10000 });
      for (const candidate of [DRAFT_URL, `${DRAFT_URL}&from=shortcut`]) {
        assert.equal(predicate(new URL(candidate)), true, candidate);
      }
      for (const candidate of [
        `${BASE}${PATH}/extra?draft=${ID}`,
        `${BASE}/app/invoices/newer?draft=${ID}`,
        `${BASE}/login?draft=${ID}`,
        `http://127.0.0.1:8092${PATH}?draft=${ID}`,
        `https://127.0.0.1:8091${PATH}?draft=${ID}`,
        `https://other.example${PATH}?draft=${ID}`,
      ])
        assert.equal(predicate(new URL(candidate)), false, candidate);
      for (const candidate of [
        `${BASE}${PATH}`,
        `${BASE}${PATH}?draft=`,
        `${BASE}${PATH}?draft=not-a-uuid`,
        `${BASE}${PATH}?draft=00000000-0000-0000-0000-000000000000`,
        `${DRAFT_URL}&draft=${ID}`,
        `${DRAFT_URL}x`,
      ])
        assert.equal(predicate(new URL(candidate)), !draftWait, candidate);
    },
    url: () => DRAFT_URL,
    async waitForSelector(selector, options) {
      calls.push(selector);
      assert.deepEqual(options, { state: "visible", timeout: 10000 });
    },
    ...overrides,
  };
  return { page, calls };
}

test("draft navigation waits for exact origin/path, canonical UUID, then visible editable form controls", async () => {
  const { page, calls } = fixture();
  await waitForNewInvoiceDraft(page, BASE);
  assert.deepEqual(calls, [
    "exact route",
    "draft identity",
    "#buyer-select:enabled:not([readonly])",
    "#invoice-number:enabled:not([readonly])",
    "#line-0-description:enabled:not([readonly])",
  ]);
});

for (const url of [
  `${BASE}${PATH}`,
  `${BASE}${PATH}?draft=malformed`,
  `${DRAFT_URL}&draft=${ID}`,
]) {
  test(`invalid draft URL cannot pass even if a navigation wait returned: ${url}`, async () => {
    const { page, calls } = fixture({ url: () => url });
    await assert.rejects(
      waitForNewInvoiceDraft(page, BASE),
      /one valid draft UUID/,
    );
    assert.deepEqual(calls, ["exact route", "draft identity"]);
  });
}

for (const missing of [
  "buyer-select",
  "invoice-number",
  "line-0-description",
]) {
  test(`a valid draft URL cannot pass with missing or disabled ${missing}`, async () => {
    const failure = new Error(`form control ${missing} not ready`);
    const { page } = fixture({
      async waitForSelector(selector) {
        if (selector.startsWith(`#${missing}:`)) throw failure;
      },
    });
    await assert.rejects(
      waitForNewInvoiceDraft(page, BASE),
      (error) => error === failure,
    );
  });
}

test("navigation timeouts remain failures, not readiness successes", async () => {
  const failure = new Error("draft identity never appeared");
  const { page } = fixture({
    waitForURL: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    waitForNewInvoiceDraft(page, BASE),
    (error) => error === failure,
  );
});

test("a redirect during form loading is rejected", async () => {
  let url = DRAFT_URL;
  const { page } = fixture({
    url: () => url,
    waitForSelector: async () => {
      url = `${BASE}/login`;
    },
  });
  await assert.rejects(
    waitForNewInvoiceDraft(page, BASE),
    /route must remain current/,
  );
});

test("invoice buyer choice is scoped to the named Customers listbox, never the draft selector", async () => {
  const calls = [];
  const page = {
    locator(selector) {
      assert.equal(selector, "#buyer-select");
      return {
        click: async () => {
          calls.push("open customers");
        },
      };
    },
    getByRole(role, options) {
      assert.equal(role, "listbox");
      assert.deepEqual(options, { name: "Customers", exact: true });
      return {
        getByRole(childRole) {
          assert.equal(childRole, "option");
          return {
            first: () => ({
              click: async () => {
                calls.push("select first customer");
              },
            }),
          };
        },
      };
    },
  };
  await selectFirstInvoiceCustomer(page);
  assert.deepEqual(calls, ["open customers", "select first customer"]);
});
