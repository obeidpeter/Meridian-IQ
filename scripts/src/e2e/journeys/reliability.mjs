/* global document, caches */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { psql } from "../../ops/common.mjs";
import {
  apiLogin,
  apiLogout,
  CSRF,
  DEMO_CLIENT_PARTY_ID,
  DEMO_PASSWORD,
  createDraftInvoice,
} from "./shared.mjs";
import {
  checkDialogKeyboard,
  collectAxeResults,
  tabTo,
} from "../accessibility.mjs";

// Each probe owns its browser storage and uniquely named records. No fixture is
// selected by row position and none depends on a preceding journey's mutation.
export async function journeyWorkerAccounts(page, BASE, check) {
  await apiLogin(page, BASE, "owner@adaezefoods.example");
  await page.goto(BASE + "/app/invoices");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" });
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const identity = async () =>
    page.evaluate(async () => {
      const response = await fetch("/api/me", { cache: "no-store" });
      return {
        status: response.status,
        body: response.ok ? await response.json() : null,
      };
    });
  const first = await identity();
  assert.equal(first.status, 200);
  await apiLogin(page, BASE, "demo.admin@valo.example");
  const second = await identity();
  check(
    "installed worker: account B never receives A identity",
    second.status === 200 && first.body.userId !== second.body.userId,
  );
  const cachedApis = await page.evaluate(async () => {
    const entries = await Promise.all(
      (await caches.keys()).map(async (name) =>
        (await (await caches.open(name)).keys()).map((request) => request.url),
      ),
    );
    return entries
      .flat()
      .filter((url) => new URL(url).pathname.startsWith("/api"));
  });
  check(
    "installed worker: CacheStorage has no API responses",
    cachedApis.length === 0,
  );
  await apiLogout(page, BASE);
  const revoked = await identity();
  check(
    "installed worker: revoked session returns 401",
    revoked.status === 401,
  );
  await page.context().setOffline(true);
  try {
    const replayed = await page.evaluate(async () => {
      try {
        return (await fetch("/api/me")).ok;
      } catch {
        return false;
      }
    });
    check(
      "installed worker: offline revoked account cannot replay identity",
      !replayed,
    );
  } finally {
    await page.context().setOffline(false);
  }
}

export async function journeyKeyboardRecovery(page, BASE, check) {
  await page.goto(BASE + "/login");
  const email = page.getByTestId("input-email");
  await email.waitFor();
  await tabTo(page, email);
  await page.keyboard.type("demo.staff@valo.example");
  await tabTo(page, page.getByTestId("input-password"));
  await page.keyboard.type(DEMO_PASSWORD);
  await tabTo(page, page.getByTestId("button-sign-in"));
  await page.keyboard.press("Enter");
  await page.waitForURL("**/app/**");
  check("keyboard login completes without pointer interaction", true);
  await page.goto(BASE + "/app/invoices/new");
  const customer = page.locator("#buyer-select");
  await customer.waitFor();
  await tabTo(page, customer);
  await page
    .getByRole("listbox", { name: "Customers", exact: true })
    .getByRole("option")
    .first()
    .waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check(
    "keyboard customer selection restores combobox focus",
    await customer.evaluate((element) => element === document.activeElement),
  );
  check(
    "keyboard customer selection chooses a named customer",
    (await customer.inputValue()).trim().length > 0,
  );
  await page.goto(BASE + "/app/invoices");
  await checkDialogKeyboard(
    page,
    page.getByTestId("button-bulk-submit"),
    page.getByRole("dialog"),
    check,
    "bulk-submit confirmation",
  );
  const results = await collectAxeResults(page);
  check(
    "keyboard recovery surface has no axe violations",
    results.violations.length === 0,
    results.violations.map((rule) => rule.id).join(", "),
  );
}

export async function journeyCustomerFailureRecovery(page, BASE, check) {
  await apiLogin(page, BASE, "demo.staff@valo.example");
  let failing = true;
  await page.route("**/api/parties?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("type") !== "buyer") return route.continue();
    if (failing)
      return route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic rate limit" }),
      });
    return route.continue();
  });
  try {
    await page.goto(BASE + "/app/invoices/new");
    await tabTo(page, page.locator("#buyer-select"));
    const customerOptions = page
      .getByRole("listbox", { name: "Customers", exact: true })
      .getByRole("option");
    const retry = page.getByRole("button", { name: "Retry search" });
    await retry.waitFor({ timeout: 20_000 });
    check(
      "customer failure is announced without false empty-success state",
      await page
        .getByRole("status")
        .filter({ hasText: "Customer search failed" })
        .isVisible(),
    );
    check(
      "customer failure cannot select a stale option",
      (await customerOptions.count()) === 0,
    );
    failing = false;
    await tabTo(page, retry);
    await page.keyboard.press("Enter");
    await customerOptions.first().waitFor({ timeout: 15_000 });
    check(
      "customer retry recovers options without reloading form",
      await page.locator("#buyer-select").isVisible(),
    );
    await page.setViewportSize({ width: 320, height: 900 });
    check(
      "customer failure recovery reflows at 320 CSS pixels",
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    );
  } finally {
    await page.unroute("**/api/parties?**");
  }
}

export async function journeyStaleInvoiceWrites(page, BASE, check) {
  await apiLogin(page, BASE, "demo.admin@valo.example");
  const partiesResponse = await page.request.get(
    BASE + "/api/parties?type=buyer&limit=200",
  );
  assert.equal(partiesResponse.status(), 200);
  const buyer = (await partiesResponse.json()).find(
    (party) => party.type === "buyer" && party.id !== DEMO_CLIENT_PARTY_ID,
  );
  assert.ok(buyer, "owned invoice fixture requires an authorized buyer");
  const created = await createDraftInvoice(page, BASE, {
    supplierPartyId: DEMO_CLIENT_PARTY_ID,
    buyerPartyId: buyer.id,
    invoiceNumber: `R198-${randomUUID()}`,
    issueDate: "2026-09-04",
    description: "Revision fixture",
    unitPrice: "100",
    quantity: "1",
  });
  assert.equal(created.status, 201);
  const read = async () => {
    const response = await page.request.get(
      BASE + `/api/invoices/${created.invoiceId}`,
    );
    assert.equal(response.status(), 200);
    return response.json();
  };
  const original = await read();
  assert.ok(
    Number.isInteger(original.invoice.contentRevision),
    "source contract must expose contentRevision",
  );
  const patch = (description) =>
    page.request.patch(BASE + `/api/invoices/${created.invoiceId}`, {
      headers: CSRF,
      data: {
        expectedRevision: original.invoice.contentRevision,
        lines: [
          { description, quantity: "1", unitPrice: "100", vatRate: "0.075" },
        ],
      },
    });
  const responses = await Promise.all([patch("Editor A"), patch("Editor B")]);
  check(
    "concurrent stale writes: exactly one edit commits",
    responses
      .map((response) => response.status())
      .sort()
      .join(",") === "200,409",
  );
  const current = await read();
  check(
    "concurrent edit increments content revision exactly once",
    current.invoice.contentRevision === original.invoice.contentRevision + 1,
  );
  const approval = await page.request.post(
    BASE + `/api/invoices/${created.invoiceId}/approve`,
    {
      headers: CSRF,
      data: { expectedRevision: original.invoice.contentRevision },
    },
  );
  check(
    "approval of stale reviewed content conflicts",
    approval.status() === 409,
  );
  const unchanged = await read();
  check(
    "stale approval leaves saved content unchanged",
    JSON.stringify(unchanged.lines) === JSON.stringify(current.lines),
  );
}

export async function journeyImportRollback(page, BASE, check) {
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "SQL failure injection requires E2E_DATABASE_DISPOSABLE=1 on a scratch database",
  );
  assert.ok(process.env.DATABASE_URL, "scratch DATABASE_URL required");
  await apiLogin(page, BASE, "owner@adaezefoods.example");
  const tag = `r198_${randomUUID().replaceAll("-", "")}`;
  const badDescription = `${tag}_fail`;
  const query = (sql) => psql(process.env.DATABASE_URL, sql);
  // The trigger affects this random fixture only; a real PostgreSQL statement
  // error occurs inside the HTTP request's ambient tenant transaction.
  query(`CREATE FUNCTION ${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.description = '${badDescription}' THEN RAISE EXCEPTION 'isolated import fixture failure' USING ERRCODE = '23514'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER ${tag} BEFORE INSERT ON invoice_lines FOR EACH ROW EXECUTE FUNCTION ${tag}();`);
  try {
    for (const size of [3, 101]) {
      const prefix = `${tag}_${size}`;
      const rows = Array.from({ length: size }, (_, index) => ({
        rowNumber: index + 1,
        invoiceNumber: `${prefix}_${index}`,
        buyerName: "Zenith Retail Ltd",
        buyerTin: "10000003-0001",
        issueDate: "2026-09-04",
        description: index === 1 ? badDescription : `${prefix}_line`,
        quantity: "1",
        unitPrice: "100",
        vatRate: "0.075",
      }));
      const response = await page.request.post(BASE + "/api/invoices/import", {
        headers: { ...CSRF, "x-idempotency-key": randomUUID() },
        data: { clientPartyId: DEMO_CLIENT_PARTY_ID, commit: true, rows },
      });
      assert.equal(
        response.status(),
        200,
        `import ${size}: failure must have an explicit row outcome`,
      );
      const result = await response.json();
      const durable = JSON.parse(
        query(
          `SELECT coalesce(json_agg(id::text ORDER BY id), '[]') FROM invoices WHERE invoice_number LIKE '${prefix}_%'`,
        ),
      );
      const reported = result.rows
        .filter((row) => row.status === "created")
        .map((row) => row.invoiceId)
        .sort();
      check(
        `HTTP import ${size}: reported successes equal independently committed rows`,
        JSON.stringify(reported) === JSON.stringify(durable.sort()),
      );
      check(
        `HTTP import ${size}: failed row has no phantom success`,
        result.rows[1].status === "invalid" &&
          result.rows[1].invoiceId === null,
      );
      check(
        `HTTP import ${size}: createdCount reflects durable rows`,
        result.createdCount === durable.length,
      );
      if (size === 3)
        check(
          "small import recovers after middle-row SQL error",
          durable.length === 2,
        );
      else
        check(
          "bulk import rolls back failed bulk attempt and retries rows without duplicates",
          durable.length === size - 1,
        );
    }
  } finally {
    query(
      `DROP TRIGGER IF EXISTS ${tag} ON invoice_lines; DROP FUNCTION IF EXISTS ${tag}();`,
    );
  }
}

export const reliabilityJourneys = [
  journeyWorkerAccounts,
  journeyKeyboardRecovery,
  journeyCustomerFailureRecovery,
  journeyStaleInvoiceWrites,
  journeyImportRollback,
];
