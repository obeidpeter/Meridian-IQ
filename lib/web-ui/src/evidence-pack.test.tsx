// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EvidenceDetailPanel } from "./evidence-detail";
import { evidenceFixtureDetail, evidenceFixtureIds } from "./evidence-fixtures";
import type { EvidenceApi, EvidenceDetailView } from "./evidence-types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPack(detail: EvidenceDetailView) {
  const api: EvidenceApi = {
    list: vi.fn(),
    detail: vi.fn().mockResolvedValue(detail),
    create: vi.fn(),
    update: vi.fn(),
    upload: vi.fn(),
    review: vi.fn(),
    scan: vi.fn(),
    assist: vi.fn(),
    download: vi.fn(),
    pack: vi.fn(),
  };
  render(
    <EvidenceDetailPanel
      api={api}
      id={detail.request.id}
      permissions={{ request: true, review: true, upload: true }}
      uploadAvailable
      scanAvailable
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  return api;
}

test.each([
  ["requested", "clean", null, false],
  ["uploaded", "clean", null, false],
  ["requested", "clean", evidenceFixtureIds.file, false],
  ["uploaded", "clean", evidenceFixtureIds.file, false],
  ["needs_changes", "clean", evidenceFixtureIds.file, false],
  ["cancelled", "clean", evidenceFixtureIds.file, false],
  ["accepted", "rejected", evidenceFixtureIds.file, false],
  ["accepted", "quarantined", evidenceFixtureIds.file, false],
  ["accepted", "clean", null, false],
  ["accepted", "clean", "missing-file", false],
  ["accepted", "clean", evidenceFixtureIds.file, true],
] as const)(
  "pack readiness: request %s, scan %s, accepted file %s => %s",
  async (status, scanStatus, acceptedFileId, ready) => {
    const detail = structuredClone(evidenceFixtureDetail);
    detail.request.status = status;
    detail.request.acceptedFileId = acceptedFileId;
    detail.files[0].scanStatus = scanStatus;
    const api = renderPack(detail);
    const button = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Download pack",
    });
    expect(button.disabled).toBe(!ready);
    if (!ready) fireEvent.click(button);
    expect(api.pack).not.toHaveBeenCalled();
  },
);

test("accepted clean packs remain disabled throughout a review mutation", async () => {
  const detail = structuredClone(evidenceFixtureDetail);
  detail.request.status = "accepted";
  detail.request.acceptedFileId = evidenceFixtureIds.file;
  const api = renderPack(detail);
  let finishReview: (value: EvidenceDetailView) => void = () => {};
  vi.mocked(api.review).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishReview = resolve;
      }),
  );
  const button = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Download pack",
  });
  expect(button.disabled).toBe(false);
  fireEvent.change(
    screen.getByRole("combobox", { name: "Decision", exact: true }),
    {
      target: { value: "needs_changes" },
    },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), {
    target: { value: "Please provide the complete signed document." },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Review evidence" }));
  await waitFor(() => expect(api.review).toHaveBeenCalledOnce());
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(api.pack).not.toHaveBeenCalled();
  const reopened = structuredClone(detail);
  reopened.request.status = "needs_changes";
  reopened.request.acceptedFileId = null;
  reopened.request.version += 1;
  await act(async () => finishReview(reopened));
  expect(button.disabled).toBe(true);
});

async function pendingDownload(kind: "pack" | "file") {
  const detail = structuredClone(evidenceFixtureDetail);
  detail.request.status = "accepted";
  detail.request.acceptedFileId = evidenceFixtureIds.file;
  const api = renderPack(detail);
  const operation =
    kind === "pack" ? vi.mocked(api.pack) : vi.mocked(api.download);
  let resolve: (blob: Blob) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  operation.mockReturnValueOnce(
    new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    }),
  );
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn().mockReturnValue("blob:evidence-download"),
      revokeObjectURL: vi.fn(),
    }),
  );
  const save = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const button = await screen.findByRole<HTMLButtonElement>("button", {
    name: kind === "pack" ? "Download pack" : "Download",
    exact: true,
  });
  button.focus();
  fireEvent.click(button);
  return {
    button,
    operation,
    save,
    async finish() {
      await act(async () =>
        resolve(new Blob([kind === "pack" ? "PK\u0003\u0004" : "%PDF-test"])),
      );
      await waitFor(() =>
        expect(button.getAttribute("aria-busy")).toBe("false"),
      );
    },
    async fail() {
      await act(async () => reject({ status: 503 }));
    },
  };
}

test.each(["pack", "file"] as const)(
  "%s download retains trigger focus while busy and ignores repeated activation",
  async (kind) => {
    const { button, operation, save, finish } = await pendingDownload(kind);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(operation).toHaveBeenCalledOnce();
    await finish();
    expect(save).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(document.activeElement).toBe(button);
  },
);

test.each(["pack", "file"] as const)(
  "%s download completion does not take focus from another chosen control",
  async (kind) => {
    const { finish } = await pendingDownload(kind);
    const other = screen.getByRole("textbox", { name: "Review comment" });
    other.focus();
    await finish();
    expect(document.activeElement).toBe(other);
  },
);

test.each(["pack", "file"] as const)(
  "%s download failure leaves focus on its error alert",
  async (kind) => {
    const { fail } = await pendingDownload(kind);
    await fail();
    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(alert);
  },
);

test("image preview preserves focus and cannot be toggled during an in-flight read", async () => {
  const detail = structuredClone(evidenceFixtureDetail);
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  Object.assign(detail.files[0], {
    filename: "delivery.png",
    contentType: "image/png",
    byteSize: bytes.length,
  });
  const api = renderPack(detail);
  let finish: (blob: Blob) => void = () => {};
  vi.mocked(api.download).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn().mockReturnValue("blob:evidence-preview"),
      revokeObjectURL: revoke,
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const preview = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Preview image",
  });
  preview.focus();
  fireEvent.click(preview);
  fireEvent.click(preview);
  expect(api.download).toHaveBeenCalledOnce();
  expect(preview.disabled).toBe(false);
  expect(preview.getAttribute("aria-disabled")).toBe("true");
  expect(preview.getAttribute("aria-busy")).toBe("true");
  expect(document.activeElement).toBe(preview);
  await act(async () => finish(new Blob([bytes])));
  await screen.findByRole("img", { name: "Evidence: delivery.png" });
  expect(preview.getAttribute("aria-busy")).toBe("false");
  expect(preview.textContent).toContain("Close preview");
  expect(document.activeElement).toBe(preview);

  fireEvent.click(
    screen.getByRole("button", { name: "Download", exact: true }),
  );
  fireEvent.click(preview);
  expect(preview.getAttribute("aria-disabled")).toBe("true");
  expect(
    screen.getByRole("img", { name: "Evidence: delivery.png" }),
  ).toBeTruthy();
  expect(revoke).not.toHaveBeenCalled();
  expect(api.download).toHaveBeenCalledTimes(2);
  await act(async () => finish(new Blob([bytes])));
  await waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("false"));
  fireEvent.click(preview);
  expect(screen.queryByRole("img")).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:evidence-preview");
});
