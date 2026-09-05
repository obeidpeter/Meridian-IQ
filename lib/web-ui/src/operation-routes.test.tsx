// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { beginOperation } from "./operation-journal";
import {
  operationDestination,
  useOperationNavigation,
} from "./operation-routes";
import {
  operationSessionKey,
  SessionActivityCenter,
} from "./session-operation-recovery";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const me = { firmId: "firm-A", userId: "user-A", clientPartyId: "client-A" };
const writers = [
  ["invoice history", "/invoices", "app"],
  ["legacy invoice create", "/invoices/new", "app"],
  ["invoice create recovery", `/invoices/new?draft=${ID}`, "app"],
  ["invoice submission", `/invoices/${ID}`, "app"],
  ["import validation and legacy import", "/import", "app"],
  ["import chunk", `/import?run=${ID}`, "app"],
  ["SME Clerk case and batch", "/clerk", "app"],
  ["console client import and mapping", "/clients/import", "console"],
  ["console client export", `/clients/${ID}`, "console"],
  ["console onboarding and report", `/clients/${ID}?view=setup`, "console"],
  ["console Clerk actions", `/clients/${ID}?view=clerk`, "console"],
] as const;
type Workspace = Parameters<typeof useOperationNavigation>[0];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function Recovery({
  workspace,
  navigate,
  assign,
  request,
}: {
  workspace: Workspace;
  navigate: (route: string) => void;
  assign: (route: string) => void;
  request: () => Promise<unknown>;
}) {
  const open = useOperationNavigation(workspace, navigate, assign);
  return <SessionActivityCenter me={me} request={request} onOpen={open} />;
}

describe.each(["app", "console", "buyer"] as const)(
  "%s recovery workspace",
  (workspace) => {
    test.each(writers)(
      "opens persisted %s in its source workspace",
      async (_writer, route, owner) => {
        beginOperation(operationSessionKey(me), {
          title: "Recover work",
          kind: "import",
          route,
        });
        const navigate = vi.fn();
        const assign = vi.fn();
        render(
          <Recovery
            workspace={workspace}
            navigate={navigate}
            assign={assign}
            request={async () => ({ operations: [] })}
          />,
        );
        await screen.findByText("Server history checked");
        fireEvent.click(screen.getByRole("button", { name: "View import" }));
        expect(operationDestination(route)).toBe(`/${owner}${route}`);
        if (workspace === owner) {
          expect(navigate).toHaveBeenCalledExactlyOnceWith(route);
          expect(assign).not.toHaveBeenCalled();
        } else {
          expect(assign).toHaveBeenCalledExactlyOnceWith(`/${owner}${route}`);
          expect(navigate).not.toHaveBeenCalled();
        }
      },
    );

    test("opens a second-device authoritative import run without dropping its query", async () => {
      const navigate = vi.fn();
      const assign = vi.fn();
      const route = `/import?run=${ID}`;
      render(
        <Recovery
          workspace={workspace}
          navigate={navigate}
          assign={assign}
          request={async () => ({
            operations: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                command: "invoice.import",
                idempotencyKey: "import-chunk-one",
                status: "succeeded",
                route,
                summary: "1 invoice created.",
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          })}
        />,
      );
      await screen.findByText("Server history checked");
      fireEvent.click(screen.getByRole("button", { name: "View import" }));
      if (workspace === "app") {
        expect(navigate).toHaveBeenCalledExactlyOnceWith(route);
        expect(assign).not.toHaveBeenCalled();
      } else {
        expect(assign).toHaveBeenCalledExactlyOnceWith(`/app${route}`);
        expect(navigate).not.toHaveBeenCalled();
      }
    });
  },
);

test.each([
  "https://foreign.invalid/import",
  "//foreign.invalid/import",
  "/\\foreign.invalid/import",
  "/app/import",
  "/console/clients/import",
  "/unknown",
  "/clients",
  "/clients/..",
  "/clients/not-a-uuid",
  `/clients/${ID}/export`,
  `/clients/${ID}?view=unknown`,
  `/clients/${ID}?view=setup&next=https://foreign.invalid`,
  `/clients/${ID}?view=setup#other`,
  `/clients/${ID}?view=SETUP`,
  `/clients/${ID}\n`,
  `/clients/${ID}/../import`,
  "/clerk?next=/console",
  "/invoices/not-a-uuid",
  `/invoices/${ID}?view=setup`,
  `/invoices/new?draft=${ID}&draft=${ID}`,
  `/invoices/new?draft=${ID}#other`,
  "/import?run=not-a-uuid",
  `/import?run=${ID}&run=${ID}`,
  `/import?run=${ID}#other`,
  `/import?run=${ID}\n`,
  `/Import?run=${ID}`,
  `/import?run=${ID.replace("-", "%2D")}`,
  "/import?%72un=" + ID,
  "/import?run=" + ID + "%0A",
  "/import?run=" + ID + "\u2028",
])(
  "unknown or unsafe local route cannot trigger either navigator: %s",
  (route) => {
    const navigate = vi.fn();
    const assign = vi.fn();
    const { result } = renderHook(() =>
      useOperationNavigation("app", navigate, assign),
    );
    result.current(route);
    expect(operationDestination(route)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  },
);

test("canonical UUIDs may use uppercase hex without changing the path or query names", () => {
  expect(operationDestination(`/import?run=${ID.toUpperCase()}`)).toBe(
    `/app/import?run=${ID.toUpperCase()}`,
  );
  expect(operationDestination(null)).toBeNull();
  expect(operationDestination({ route: "/import" })).toBeNull();
});
