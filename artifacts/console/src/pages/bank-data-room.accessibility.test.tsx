// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BankDataRoom } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  room: {
    data: undefined as BankDataRoom | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  access: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetBankDataRoom: () => harness.room,
    useListBankDataRoomAccess: (...args: unknown[]) => {
      harness.access(...args);
      return { data: [], isFetching: false };
    },
  };
});
import { BankDataRoom as BankDataRoomPage } from "./bank-data-room";

beforeEach(() => {
  Object.assign(harness.room, {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
  });
  harness.room.refetch.mockClear();
  harness.access.mockClear();
});
afterEach(cleanup);

test("Data Room loading has a named status and keeps its H1 without enabling access-history reads", () => {
  harness.room.isLoading = true;
  render(<BankDataRoomPage />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Credit Data Room" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("status", { name: "Loading bank Data Room" }),
  ).toBeTruthy();
  expect(harness.access).toHaveBeenCalledWith(
    { limit: 50 },
    expect.objectContaining({
      query: expect.objectContaining({ enabled: false }),
    }),
  );
});

test("endpoint failure retains the heading and retry without showing cohort data", () => {
  harness.room.isError = true;
  render(<BankDataRoomPage />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Credit Data Room" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(harness.room.refetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("table")).toBeNull();
});

test("withheld cohort keeps its privacy boundary and does not expose financial metrics", () => {
  harness.room.data = {
    available: false,
    metrics: null,
    privacy: { minimumCohortSize: 5 },
  } as BankDataRoom;
  render(<BankDataRoomPage />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Credit Data Room" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", {
      level: 2,
      name: "Cohort withheld for privacy",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("region", { name: "Credit evidence summary" }),
  ).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});
