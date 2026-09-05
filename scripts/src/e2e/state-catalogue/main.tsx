import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityCenter } from "../../../../lib/web-ui/src/operation-status";
import type {
  OperationRecord,
  OperationSyncState,
} from "../../../../lib/web-ui/src/operation-journal";
import { NetworkStatus } from "../../../../lib/web-ui/src/network-status";
import {
  RouteLoading,
  lazyRoute,
} from "../../../../lib/web-ui/src/route-recovery";
import { SessionOperationRecovery } from "../../../../lib/web-ui/src/session-operation-recovery";
import "./catalogue.css";

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "empty";
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);
if (params.get("text") === "200")
  document.documentElement.style.fontSize = "200%";

const legalName =
  "Chukwuemeka-Alexandria International Agricultural Processing and Distribution Cooperative Limited";
const email =
  "alexandria.chukwuemeka.accounts.payable+westafrica@international-distribution.example";
const timestamp = "2026-09-03T09:00:00.000Z";
const operation: OperationRecord = {
  id: "catalogue-local",
  serverId: "11111111-1111-4111-8111-111111111111",
  title: legalName,
  kind: "import",
  command: "invoice.import",
  idempotencyKey: "catalogue-intent",
  status: "partial",
  route: "/import",
  detail: `Contact ${email}. Total NGN 999,999,999,999.99.`,
  savedSummary:
    "2 of 3 rows saved. Row 3 requires review; no invoice was created for that row.",
  startedAt: timestamp,
  updatedAt: timestamp,
  verification: "server",
  verifiedAt: timestamp,
};
const sync: Record<string, OperationSyncState> = {
  empty: "synced",
  offline: "offline",
  stale: "unavailable",
  partial: "synced",
  forbidden: "forbidden",
  disabled: "syncing",
  failed: "synced",
  running: "syncing",
};
let attempts = 0;
const BrokenRoute = lazyRoute(async () => {
  if (attempts++ === 0)
    throw Object.assign(new Error("Synthetic chunk failure"), {
      requestId: "request-" + "r".repeat(120),
    });
  return { default: () => <h1>Page recovered</h1> };
});
const me = {
  userId: "catalogue-user",
  firmId: "catalogue-firm",
  clientPartyId: "catalogue-client",
};
const summary = {
  ...operation,
  summary: operation.savedSummary,
  id: operation.serverId,
};
async function request(path: string) {
  if (path.includes("/lookup") || /\/operations\/[0-9a-f-]{36}/.test(path)) {
    return {
      ...summary,
      result: {
        statusCode: 200,
        body: {
          supplier: legalName,
          contact: email,
          total: "999999999999.99",
          createdCount: 2,
          invalidCount: 1,
        },
      },
    };
  }
  return { operations: [summary], nextCursor: null };
}
function Catalogue() {
  const [records, setRecords] = useState<OperationRecord[]>(
    ["empty", "forbidden"].includes(state)
      ? []
      : [
          {
            ...operation,
            status:
              state === "failed"
                ? "failed"
                : state === "running"
                  ? "running"
                  : "partial",
            verification: ["offline", "stale", "running"].includes(state)
              ? "unconfirmed"
              : "server",
            verifiedAt: ["offline", "stale", "running"].includes(state)
              ? undefined
              : timestamp,
            savedSummary:
              state === "failed"
                ? "0 of 3 rows saved. Review validation errors before starting a new import."
                : state === "running"
                  ? "Result not confirmed. Keep the original retry key."
                  : operation.savedSummary,
          },
        ],
  );
  const [opened, setOpened] = useState("");
  return (
    <main className="catalogue" data-state={state}>
      {state !== "route-failed" && (
        <header>
          <h1>Operation history</h1>
          <p>{state}</p>
        </header>
      )}
      <div data-specimen>
        {state === "loading" ? (
          <RouteLoading />
        ) : state === "route-failed" ? (
          <BrokenRoute />
        ) : state === "dialog" ? (
          <SessionOperationRecovery
            me={me}
            request={request}
            onOpen={setOpened}
          />
        ) : (
          <>
            {state === "offline" && <NetworkStatus />}
            <ActivityCenter
              operations={records}
              syncState={sync[state]}
              onOpen={setOpened}
              onDismiss={(id) =>
                setRecords((current) =>
                  current.filter((entry) => entry.id !== id),
                )
              }
              onClearCompleted={() =>
                setRecords((current) =>
                  current.filter((entry) => entry.status !== "succeeded"),
                )
              }
              onRefresh={() => {}}
              onRecover={async () => {
                if (state === "disabled") return new Promise<void>(() => {});
                if (state === "failed")
                  throw new Error("Synthetic response loss");
                setRecords((current) =>
                  current.map((entry) => ({
                    ...entry,
                    serverResult: {
                      statusCode: 200,
                      body: {
                        supplier: legalName,
                        contact: email,
                        total: "999999999999.99",
                      },
                    },
                  })),
                );
              }}
            />
          </>
        )}
      </div>
      {opened && <p role="status">Opened source: {opened}</p>}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Catalogue />);
