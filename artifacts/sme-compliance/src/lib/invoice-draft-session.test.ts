// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { InvoiceDraftSession } from "./invoice-draft-session";
import {
  draftStorageKey,
  emptyInvoiceDraft,
  listDraftRecoveries,
} from "./invoice-draft";
import type { InvoiceDraftApi, ServerInvoiceDraft } from "./invoice-draft-api";

const KEY = draftStorageKey("user", "firm", "client");
const content = (invoiceNumber: string) => ({
  ...emptyInvoiceDraft(),
  invoiceNumber,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fakeServer() {
  let row: ServerInvoiceDraft | undefined;
  let deleted = false;
  const api: InvoiceDraftApi = {
    get: vi.fn(async () => {
      if (!row || deleted) throw { status: 404 };
      return structuredClone(row);
    }),
    save: vi.fn(async (id, input) => {
      if (deleted) throw { status: 409 };
      if (row?.writeId === input.writeId) return structuredClone(row);
      if ((row?.revision ?? 0) !== input.expectedRevision)
        throw { status: 409 };
      row = {
        id,
        revision: input.expectedRevision + 1,
        writeId: input.writeId,
        draft: structuredClone(input.draft),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 604800000).toISOString(),
      };
      return structuredClone(row);
    }),
    remove: vi.fn(async (_id, revision) => {
      if ((row?.revision ?? 0) !== revision) throw { status: 409 };
      deleted = true;
    }),
  };
  return api;
}
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("durable invoice draft sessions", () => {
  test("an unresolved submission blocks buyer/amount edits, autosave, reload and discard across refresh", async () => {
    const api = fakeServer();
    const session = new InvoiceDraftSession(KEY, "one", api);
    await session.load();
    session.edit({
      ...content("ORIGINAL"),
      buyerPartyId: "buyer-1",
      lines: [
        {
          description: "Goods",
          quantity: "1",
          unitPrice: "1000",
          vatRate: "0.075",
        },
      ],
    });
    await session.save();
    const body = {
      supplierPartyId: "client",
      buyerPartyId: "buyer-1",
      invoiceNumber: "ORIGINAL",
      currency: "NGN",
      issueDate: "2026-09-04",
      lines: [
        {
          description: "Goods",
          quantity: "1",
          unitPrice: "1000",
          vatRate: "0.075",
        },
      ],
    };
    await session.prepareSubmission(body, () => {});
    session.edit((draft) => ({
      ...draft,
      buyerPartyId: "buyer-2",
      lines: [{ ...draft.lines[0], unitPrice: "9000" }],
    }));
    expect(session.state.draft.buyerPartyId).toBe("buyer-1");
    expect(session.state.draft.lines[0].unitPrice).toBe("1000");
    expect(await session.save()).toBe(false);
    expect(await session.reload()).toBe(false);
    expect(await session.discard()).toBe(false);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.remove).not.toHaveBeenCalled();
    session.deactivate();
    const restored = new InvoiceDraftSession(KEY, "one", api);
    await restored.load();
    expect(restored.state.draft.buyerPartyId).toBe("buyer-1");
    const retry = await restored.prepareSubmission(
      { ...body, buyerPartyId: "buyer-2" },
      () => {},
    );
    expect(retry).toMatchObject({
      firstDispatch: false,
      submission: { status: "pending", key: "invoice-create:one", body },
    });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  test.each(["navigation", "logout", "scope change"])(
    "%s aborts a late save without repersisting or sending queued edits",
    async (boundary) => {
      let ownerCurrent = true;
      const api = fakeServer();
      const original = api.save;
      const response = deferred<ServerInvoiceDraft>();
      api.save = vi.fn(() => response.promise);
      const session = new InvoiceDraftSession(
        KEY,
        "one",
        api,
        undefined,
        () => ownerCurrent,
      );
      await session.load();
      session.edit(content("A"));
      const saving = session.save();
      const [id, input, signal] = vi.mocked(api.save).mock.calls[0];
      session.edit(content("B"));
      if (boundary !== "navigation") ownerCurrent = false;
      if (boundary === "logout") session.invalidate();
      else session.deactivate();
      expect(signal?.aborted).toBe(true);
      if (boundary === "navigation")
        expect(listDraftRecoveries(KEY)[0].draft.invoiceNumber).toBe("B");
      localStorage.clear();
      const writes = vi.spyOn(Storage.prototype, "setItem");
      const removals = vi.spyOn(Storage.prototype, "removeItem");
      response.resolve(await original(id, input));
      expect(await saving).toBe(false);
      session.edit(content("stale"));
      session.persist();
      session.externalChange();
      expect(await session.save()).toBe(false);
      await session.load();
      expect(await session.reload()).toBe(false);
      expect(await session.discard()).toBe(false);
      session.complete();
      expect(api.save).toHaveBeenCalledTimes(1);
      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.remove).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(removals).not.toHaveBeenCalled();
    },
  );

  test("an owner generation change rejects late work even before cleanup runs", async () => {
    let current = true;
    const api = fakeServer();
    const response = deferred<ServerInvoiceDraft>();
    api.save = vi.fn(() => response.promise);
    const session = new InvoiceDraftSession(
      KEY,
      "one",
      api,
      undefined,
      () => current,
    );
    await session.load();
    session.edit(content("A"));
    const saving = session.save();
    session.edit(content("B"));
    current = false;
    localStorage.clear();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    response.reject(new Error("late failure"));
    expect(await saving).toBe(false);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
  });

  test.each([
    ["load", false],
    ["load", true],
    ["reload", false],
    ["reload", true],
    ["discard", false],
    ["discard", true],
  ] as const)(
    "a late %s response (failure=%s) cannot mutate or persist a detached session",
    async (method, failure) => {
      const api = fakeServer();
      const session = new InvoiceDraftSession(KEY, "one", api);
      await session.load();
      session.edit(content("A"));
      await session.save();
      const row = await api.get("one");
      const response = deferred<ServerInvoiceDraft>();
      const removal = deferred<void>();
      api.get = vi.fn(() => response.promise);
      api.remove = vi.fn(() => removal.promise);
      const running = session[method]();
      const signal =
        method === "discard"
          ? vi.mocked(api.remove).mock.calls[0][2]
          : vi.mocked(api.get).mock.calls[0][1];
      session.deactivate();
      const before = session.state;
      localStorage.clear();
      const writes = vi.spyOn(Storage.prototype, "setItem");
      const removals = vi.spyOn(Storage.prototype, "removeItem");
      expect(signal?.aborted).toBe(true);
      if (failure) {
        if (method === "discard") removal.reject(new Error("late rejection"));
        else response.reject(new Error("late rejection"));
      } else {
        response.resolve({ ...row, draft: content("late remote") });
        removal.resolve();
      }
      await running;
      expect(session.state).toBe(before);
      expect(writes).not.toHaveBeenCalled();
      expect(removals).not.toHaveBeenCalled();
    },
  );

  test.each(["reload", "discard"] as const)(
    "%s waiting on a save does not send another request after invalidation",
    async (method) => {
      const api = fakeServer();
      const original = api.save;
      const response = deferred<ServerInvoiceDraft>();
      api.save = vi.fn(() => response.promise);
      const session = new InvoiceDraftSession(KEY, "one", api);
      await session.load();
      session.edit(content("A"));
      const saving = session.save();
      const running = session[method]();
      session.invalidate();
      localStorage.clear();
      const writes = vi.spyOn(Storage.prototype, "setItem");
      const removals = vi.spyOn(Storage.prototype, "removeItem");
      const [id, input] = vi.mocked(api.save).mock.calls[0];
      response.resolve(await original(id, input));
      expect(await saving).toBe(false);
      expect(await running).toBe(false);
      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.remove).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(removals).not.toHaveBeenCalled();
    },
  );

  test("reactivation rejects the previous lifecycle's save without clearing the new flight", async () => {
    const api = fakeServer();
    const original = api.save;
    const first = deferred<ServerInvoiceDraft>();
    const second = deferred<ServerInvoiceDraft>();
    api.save = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const session = new InvoiceDraftSession(KEY, "one", api);
    await session.load();
    session.edit(content("A"));
    const stale = session.save();
    session.deactivate();
    expect(session.activate()).toBe(true);
    await session.load();
    const current = session.save();
    const [id, input] = vi.mocked(api.save).mock.calls[0];
    const row = await original(id, input);
    first.resolve(row);
    expect(await stale).toBe(false);
    expect(session.save()).toBe(current);
    second.resolve(row);
    expect(await current).toBe(true);
    expect(session.state.status).toBe("saved");
    expect(api.save).toHaveBeenCalledTimes(2);
  });

  test("reload does not overwrite edits made while its response is pending", async () => {
    const api = fakeServer();
    const session = new InvoiceDraftSession(KEY, "one", api);
    await session.load();
    session.edit(content("base"));
    await session.save();
    const row = await api.get("one");
    const response = deferred<ServerInvoiceDraft>();
    api.get = vi.fn(() => response.promise);
    const reload = session.reload();
    session.edit(content("new typing"));
    response.resolve({ ...row, draft: content("remote") });
    expect(await reload).toBe(false);
    expect(session.state.draft.invoiceNumber).toBe("new typing");
    expect(session.state.dirty).toBe(true);
  });
  test("flushes every manual edit locally before the server debounce", async () => {
    const api = fakeServer();
    const session = new InvoiceDraftSession(KEY, "one", api);
    await session.load();
    session.edit(content("final keystroke"));
    expect(listDraftRecoveries(KEY)[0].draft.invoiceNumber).toBe(
      "final keystroke",
    );
    expect(api.save).not.toHaveBeenCalled();
    expect(session.state.status).toBe("local");
  });
  test("two distinct slots and tab recovery files cannot overwrite each other", async () => {
    const first = new InvoiceDraftSession(KEY, "one", fakeServer());
    const second = new InvoiceDraftSession(KEY, "two", fakeServer());
    await first.load();
    await second.load();
    first.edit(content("A"));
    second.edit(content("B"));
    expect(
      listDraftRecoveries(KEY)
        .map((r) => r.draft.invoiceNumber)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(
      listDraftRecoveries(draftStorageKey("user", "firm", "sibling")),
    ).toEqual([]);
  });
  test("same-revision writers conflict without discarding either tab's edits", async () => {
    const api = fakeServer();
    const first = new InvoiceDraftSession(KEY, "shared", api);
    await first.load();
    first.edit(content("base"));
    await first.save();
    const second = new InvoiceDraftSession(KEY, "shared", api);
    await second.load();
    first.edit(content("A"));
    second.edit(content("B"));
    expect(await first.save()).toBe(true);
    expect(await second.save()).toBe(false);
    expect(second.state.status).toBe("conflict");
    expect(second.state.draft.invoiceNumber).toBe("B");
    expect(
      listDraftRecoveries(KEY).some((copy) => copy.draft.invoiceNumber === "B"),
    ).toBe(true);
    expect((await api.get("shared")).draft.invoiceNumber).toBe("A");
  });
  test("response loss retries the identical write ID and revision after further edits", async () => {
    const api = fakeServer();
    const originalSave = api.save;
    let drop = true;
    api.save = vi.fn(async (id, input) => {
      const result = await originalSave(id, input);
      if (drop) {
        drop = false;
        throw new Error("lost response");
      }
      return result;
    });
    const session = new InvoiceDraftSession(KEY, "one", api);
    await session.load();
    session.edit(content("A"));
    expect(await session.save()).toBe(false);
    session.edit(content("B"));
    expect(await session.save()).toBe(true);
    const calls = vi.mocked(api.save).mock.calls;
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(calls[2][1].expectedRevision).toBe(1);
    expect(calls[2][1].writeId).not.toBe(calls[0][1].writeId);
    expect((await api.get("one")).draft.invoiceNumber).toBe("B");
  });
  test("refresh reconciles a committed write whose response was lost", async () => {
    const api = fakeServer();
    const original = api.save;
    api.save = vi.fn(async (id, input) => {
      await original(id, input);
      throw new Error("lost");
    });
    const session = new InvoiceDraftSession(KEY, "one", api);
    await session.load();
    session.edit(content("A"));
    await session.save();
    const recovered = new InvoiceDraftSession(
      KEY,
      "one",
      api,
      listDraftRecoveries(KEY)[0],
    );
    await recovered.load();
    expect(recovered.state).toMatchObject({
      revision: 1,
      dirty: false,
      status: "saved",
    });
    expect(api.save).toHaveBeenCalledTimes(1);
  });
  test("edits made while saving are queued after the acknowledged revision", async () => {
    const api = fakeServer();
    const original = api.save;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.save = vi.fn(async (id, input) => {
      await barrier;
      return original(id, input);
    });
    const session = new InvoiceDraftSession(KEY, "one", api);
    await session.load();
    session.edit(content("A"));
    const saving = session.save();
    session.edit(content("B"));
    release();
    await saving;
    expect(session.state).toMatchObject({
      revision: 2,
      dirty: false,
      status: "saved",
    });
    expect((await api.get("one")).draft.invoiceNumber).toBe("B");
  });
  test("storage failure never claims local persistence", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const api = fakeServer();
    const session = new InvoiceDraftSession(KEY, "one", api);
    await session.load();
    session.edit(content("A"));
    expect(session.state.localSaved).toBe(false);
    await session.save();
    expect(session.state.status).toBe("saved");
  });
  test("external changes protect dirty content and refresh clean sessions", async () => {
    const api = fakeServer();
    const session = new InvoiceDraftSession(KEY, "one", api);
    await session.load();
    session.edit(content("mine"));
    session.externalChange();
    expect(session.state.status).toBe("conflict");
    expect(await session.save()).toBe(false);
  });
  test("a discarded draft cannot be autosaved by a stale tab", async () => {
    const api = fakeServer();
    const first = new InvoiceDraftSession(KEY, "one", api);
    await first.load();
    first.edit(content("base"));
    await first.save();
    const second = new InvoiceDraftSession(KEY, "one", api);
    await second.load();
    await first.discard();
    second.edit(content("late"));
    expect(await second.save()).toBe(false);
    expect(second.state.status).toBe("conflict");
  });
});
