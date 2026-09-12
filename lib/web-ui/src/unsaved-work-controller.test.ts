import { expect, test, vi } from "vitest";
import {
  UnsavedWorkController,
  type UnsavedWorkHandler,
} from "./unsaved-work-controller";

function setup() {
  const work = new UnsavedWorkController();
  const handler: UnsavedWorkHandler = {
    isDirty: vi.fn(() => true),
    save: vi.fn(async () => true),
    discard: vi.fn(() => true),
  };
  const unregister = work.register(handler);
  const proceed = vi.fn();
  return { work, handler, unregister, proceed };
}

test("clean navigation runs immediately; Stay cancels only the pending destination", () => {
  const { work, handler, proceed } = setup();
  vi.mocked(handler.isDirty).mockReturnValue(false);
  work.request(proceed);
  expect(proceed).toHaveBeenCalledOnce();
  vi.mocked(handler.isDirty).mockReturnValue(true);
  work.request(proceed);
  work.stay();
  expect(work.isDirty()).toBe(true);
  expect(work.getSnapshot()).toBeNull();
  expect(proceed).toHaveBeenCalledOnce();
  expect(handler.discard).not.toHaveBeenCalled();
});

test("Discard runs before the original destination and repeated attempts cannot replace it", () => {
  const { work, handler, proceed } = setup();
  const second = vi.fn();
  work.request(proceed);
  work.request(second);
  work.discard();
  work.discard();
  expect(handler.discard).toHaveBeenCalledOnce();
  expect(proceed).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
});

test.each([false, new Error("Network failure"), new Error("Conflict")])(
  "failed save %s never releases navigation",
  async (result) => {
    const { work, handler, proceed } = setup();
    if (result instanceof Error)
      vi.mocked(handler.save).mockRejectedValueOnce(result);
    else vi.mocked(handler.save).mockResolvedValueOnce(result);
    work.request(proceed);
    await work.save();
    expect(proceed).not.toHaveBeenCalled();
    expect(work.getSnapshot()).toMatchObject({
      busy: false,
      error: expect.any(String),
    });
    await work.save();
    expect(proceed).toHaveBeenCalledOnce();
  },
);

test("double Save and Discard cannot overlap a save; Stay cancels its pending navigation", async () => {
  const { work, handler, proceed } = setup();
  let finish!: (saved: boolean) => void;
  vi.mocked(handler.save).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  work.request(proceed);
  const saving = work.save();
  await work.save();
  work.discard();
  expect(handler.save).toHaveBeenCalledOnce();
  expect(handler.discard).not.toHaveBeenCalled();
  work.stay();
  finish(true);
  await saving;
  expect(proceed).not.toHaveBeenCalled();
});

test("unregistering an owner cancels even an already-running save continuation", async () => {
  const { work, handler, unregister, proceed } = setup();
  let finish!: (saved: boolean) => void;
  vi.mocked(handler.save).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  work.request(proceed);
  const saving = work.save();
  unregister();
  finish(true);
  await saving;
  expect(proceed).not.toHaveBeenCalled();
  expect(work.getSnapshot()).toBeNull();
  expect(work.isDirty()).toBe(false);
});

test("disabled save explains why and a refused discard cannot release navigation", async () => {
  const { work, handler, proceed } = setup();
  handler.saveDisabledReason = () => "Refresh account permissions.";
  vi.mocked(handler.discard).mockReturnValue(false);
  work.request(proceed);
  await work.save();
  expect(handler.save).not.toHaveBeenCalled();
  expect(work.getSnapshot()?.error).toBe("Refresh account permissions.");
  work.discard();
  expect(proceed).not.toHaveBeenCalled();
});

test("all dirty owners must confirm success before navigation", async () => {
  const { work, proceed } = setup();
  work.register({
    isDirty: () => true,
    save: async () => false,
    discard: () => true,
  });
  work.request(proceed);
  await work.save();
  expect(proceed).not.toHaveBeenCalled();
});
