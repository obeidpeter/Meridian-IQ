import assert from "node:assert/strict";
import test from "node:test";
import { blankLine } from "./invoice-form.ts";
import {
  clearInvoiceIntents,
  invoiceIntentStorageKey,
  newInvoiceIntent,
  prepareInvoiceIntent,
  confirmInvoiceIntent,
  readInvoiceIntent,
  saveInvoiceIntent,
} from "./invoice-intent.ts";
const scope = { userId: "user-A", firmId: "firm-A", clientPartyId: "client-A" };
const form = {
  buyerPartyId: null,
  invoiceNumber: "INV-1",
  issueDate: "2026-09-04",
  notes: "",
  lines: [blankLine("1")],
};
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
    getAllKeys: async () => [...values.keys()],
    multiRemove: async (keys: string[]) => {
      keys.forEach((key) => values.delete(key));
    },
  };
}
test("retry and restart retain the intent key; identical new invoices do not reuse it", async () => {
  const data = storage();
  const intent = newInvoiceIntent(scope, form);
  await saveInvoiceIntent(data, intent, () => true);
  assert.deepEqual(await readInvoiceIntent(data, scope), intent);
  assert.notEqual(newInvoiceIntent(scope, form).key, intent.key);
});
test("all identity dimensions isolate persisted drafts", async () => {
  const data = storage();
  await saveInvoiceIntent(data, newInvoiceIntent(scope, form), () => true);
  for (const other of [
    { ...scope, userId: "B" },
    { ...scope, firmId: "B" },
    { ...scope, clientPartyId: "B" },
  ]) {
    assert.notEqual(
      invoiceIntentStorageKey(other),
      invoiceIntentStorageKey(scope),
    );
    assert.equal(await readInvoiceIntent(data, other), null);
  }
});
test("logout clears all invoice intents and rejects late old-session persistence", async () => {
  const data = storage();
  await saveInvoiceIntent(data, newInvoiceIntent(scope, form), () => true);
  data.values.set("unrelated", "preserve");
  await clearInvoiceIntents(data);
  await assert.rejects(
    saveInvoiceIntent(data, newInvoiceIntent(scope, form), () => false),
  );
  assert.deepEqual([...data.values], [["unrelated", "preserve"]]);
});
test("corrupt or mismatched records fail closed instead of silently creating a new intent", async () => {
  const data = storage();
  data.values.set(
    invoiceIntentStorageKey(scope),
    JSON.stringify({
      ...newInvoiceIntent(scope, form),
      scope: { ...scope, userId: "B" },
    }),
  );
  await assert.rejects(readInvoiceIntent(data, scope));
});

test("lost response retains the original key and payload while edits require a separate intent", async () => {
  const data = storage();
  const payload = {
    supplierPartyId: scope.clientPartyId,
    buyerPartyId: "buyer",
    invoiceNumber: "INV-1",
    issueDate: form.issueDate,
    kind: "invoice" as const,
    category: "b2b" as const,
    lines: [],
  };
  const intent = prepareInvoiceIntent(
    newInvoiceIntent(scope, form),
    form,
    payload,
  );
  await saveInvoiceIntent(data, intent, () => true);
  const restored = (await readInvoiceIntent(data, scope))!;
  assert.equal(prepareInvoiceIntent(restored, form, payload).key, intent.key);
  assert.throws(
    () =>
      prepareInvoiceIntent(restored, form, {
        ...payload,
        invoiceNumber: "INV-2",
      }),
    /original invoice/,
  );
  const confirmed = confirmInvoiceIntent(restored, "server-invoice");
  await saveInvoiceIntent(data, confirmed, () => true);
  assert.equal((await readInvoiceIntent(data, scope))?.key, null);
  assert.equal(
    (await readInvoiceIntent(data, scope))?.invoiceId,
    "server-invoice",
  );
});
