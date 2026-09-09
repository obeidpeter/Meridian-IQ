import { reliability } from "../../../artifacts/console/src/pages/control-centre/__tests__/fixtures.ts";
import { API_CONTRACT_VERSION } from "../../../lib/api-zod/src/generated/version.ts";

export const reliabilityEndpoint = "/api/operator/integration-reliability";

// Extend the existing control-centre fixture, retaining the real response shape.
export function reliabilityFixture(state = "populated") {
  const data = structuredClone(reliability);
  data.totalConnections = 3;
  data.healthyConnections = 1;
  data.connectionsTruncated = false;
  data.connections = data.connections.map((connection, index) => ({
    ...connection,
    clientName:
      index === 0
        ? `Client${"UnbrokenReference".repeat(12)}`
        : `Fixture client ${index}`,
    firmName: `Practice${"LongLegalName".repeat(12)}`,
    connectorKey: `connector_${"identifier".repeat(14)}`,
    issue:
      index === 0
        ? null
        : `Review diagnostic ${"UnbrokenDiagnostic".repeat(14)}`,
    recordsRead: 1234567890123,
    recordsWritten: 1234567890120,
    errorCount: index === 0 ? 0 : 3,
  }));
  data.qualitySignals = ["critical", "warning", "info"].map(
    (severity, index) => ({
      ...data.qualitySignals[0],
      key: severity,
      severity,
      label: `${severity} signals`,
      count: index + 1,
      detail: `Review ${"LongSignalReference".repeat(12)}`,
    }),
  );
  data.qualitySignals.push({
    ...data.qualitySignals[0],
    key: "zero",
    count: 0,
  });
  if (state === "partial") {
    data.totalConnections = 1000003;
    data.healthyConnections = 1000001;
    data.connectionsTruncated = true;
    data.connections[1].lastSyncAt = null;
    data.connections[1].latestRunStatus = null;
  }
  if (state === "empty") {
    for (const key of [
      "totalConnections",
      "healthyConnections",
      "attentionConnections",
      "failedRuns24h",
      "invalidRows30d",
      "deadLetters",
      "openRails",
    ])
      data[key] = 0;
    data.connections = [];
    data.qualitySignals = data.qualitySignals.map((signal) => ({
      ...signal,
      count: 0,
    }));
  }
  return data;
}

export function shellFixtures() {
  return {
    "/api/me": {
      userId: "fixture-operator",
      firmId: "fixture-firm",
      role: "operator",
      fullName: "Workspace usability fixture operator",
      email: "workspace-usability@example.test",
      workspaceName: "Control Centre fixture practice",
      capabilities: ["operator.queue.read"],
      features: [],
      consentCaptured: true,
      clientPartyId: null,
      buyerPartyId: null,
    },
    "/api/healthz": { status: "ok", contractVersion: API_CONTRACT_VERSION },
    "/api/notifications": { items: [], nextCursor: null, unreadCount: 0 },
    "/api/operations": { operations: [], nextCursor: null },
  };
}
