import type {
  GateMetrics,
  BuyerPilotWorkspace,
  ComplianceOperationsWorkspace,
  IntegrationReliabilityWorkspace,
  EvidenceVaultWorkspace,
  ClerkAssuranceWorkspace,
} from "@workspace/api-client-react";

const generatedAt = "2026-09-05T00:00:00Z";
const firmName = "Control Centre fixture practice";
const clientName = "Meridian Regional Distribution and Logistics Limited";

export const activation: GateMetrics = {
  subscribedFirms: 75,
  activeClients: 120,
  namedProspects: 150,
  onboardingProspects: 25,
  convertedProspects: 75,
  prospectConversionRate: 0.5,
  stampedInvoices: 987654,
  medianHoursToStamp: 12,
  failedInvoicesTotal: 10,
  failureSelfResolutionRate: 0.8,
  creditObservableCount: 150,
  confirmationsLast30d: 25,
  confirmationRequests30d: 20,
  confirmationResponses30d: 15,
  buyerResponseRate30d: 0.75,
  anchorBuyers: 3,
  reconciliationAcceptRate: 0.9,
  openEscalations: 2,
  featureFlagsEnabled: 5,
  featureFlagsTotal: 8,
  releaseReadiness: [
    { releaseTag: "r198", enabledFlags: 5, totalFlags: 8, status: "partial" },
  ],
};

export const buyers: BuyerPilotWorkspace = {
  generatedAt,
  anchorBuyers: 5,
  activeBuyers30d: 2,
  pendingConfirmations: 4,
  confirmationResponses30d: 15,
  buyerResponseRate30d: 0.75,
  medianResponseHours: 2,
  pilotsTruncated: true,
  pilots: (["live", "proving", "scale_ready"] as const).map((stage, index) => ({
    buyerPartyId: `buyer-${index}`,
    buyerName: `${clientName} ${index + 1}`,
    tinValidated: true,
    supplierCount: 1234,
    invoiceCount: 987654,
    stampedCount: 987650,
    pendingConfirmations: 4,
    responseCount: 15,
    confirmedCount: 12,
    responseRate: 0.75,
    paidSignals: 300,
    medianResponseHours: 2,
    lastActivityAt: generatedAt,
    readinessScore: [0, 65, 100][index],
    stage,
    blockers:
      index === 2
        ? []
        : ["Supplier identity", "Stamped flow", "Buyer response"],
  })),
};

export const cases: ComplianceOperationsWorkspace = {
  generatedAt,
  openItems: 6,
  overdueItems: 1,
  dueSoonItems: 2,
  highPriorityItems: 1,
  unassignedCases: 1,
  itemsTruncated: true,
  items: (
    ["operator_case", "filing", "obligation", "buyer_confirmation"] as const
  ).map((kind, index) => ({
    key: `case-${index}`,
    entityId: `case-${index}`,
    kind,
    title: "Review pending compliance evidence",
    firmName,
    clientName,
    priority: index === 0 ? "high" : "medium",
    status: "open",
    dueAt: generatedAt,
    ageHours: 72,
    slaState: index === 0 ? "overdue" : "due_soon",
    detail: "Awaiting an attributable operator decision",
    actionHref: "/cases",
  })),
};

export const reliability: IntegrationReliabilityWorkspace = {
  generatedAt,
  totalConnections: 5,
  healthyConnections: 3,
  attentionConnections: 2,
  failedRuns24h: 1,
  invalidRows30d: 10,
  deadLetters: 1,
  openRails: 1,
  connectionsTruncated: true,
  connections: (["healthy", "stale", "incident"] as const).map(
    (operationalState, index) => ({
      id: `connection-${index}`,
      type: index === 0 ? "erp" : "bank_feed",
      connectorKey: "fixture-connector",
      firmName,
      clientName,
      connectionStatus: "connected",
      operationalState,
      lastSyncAt: generatedAt,
      latestRunStatus: "completed",
      recordsRead: 987654,
      recordsWritten: 987650,
      errorCount: 4,
      issue: index === 0 ? null : "Review the latest synchronization result",
    }),
  ),
  qualitySignals: [
    {
      key: "rejected",
      label: "Rejected rows",
      count: 10,
      severity: "warning",
      detail: "Review and reconcile rejected records",
      actionHref: "/clients/import",
    },
  ],
};

export const evidence: EvidenceVaultWorkspace = {
  generatedAt,
  totalArtifacts: 987654,
  artifactsLast30d: 1234,
  auditChainValid: true,
  auditEventCount: 1234567,
  retentionCoverageRate: 0.95,
  legalHolds: 3,
  items: (
    [
      "invoice_stamp",
      "filing_acknowledgement",
      "obligation_resolution",
      "settlement_signal",
    ] as const
  ).map((kind, index) => ({
    key: `evidence-${index}`,
    entityId: `evidence-${index}`,
    kind,
    title: "Recorded compliance evidence",
    firmName,
    clientName,
    reference: "INV-2026-123456789",
    recordedAt: generatedAt,
    integrity: "tamper_evident",
    actionHref: "/invoices",
  })),
  trustControls: [
    {
      key: "integrity",
      label: "Audit integrity",
      status: "healthy",
      detail: "Evidence chain verified",
    },
  ],
};

export const clerk: ClerkAssuranceWorkspace = {
  generatedAt,
  calls30d: 1000,
  pendingReview: 3,
  decidedCases30d: 12,
  invalidRate30d: 0.01,
  errorRate30d: 0.01,
  latencyP95Ms: 1234,
  tokens30d: 987654,
  latestEvalAccuracy: 0.98,
  latestInjectionResistance: 1,
  groundingViolations30d: 0,
  guardrails: (["healthy", "watch", "critical"] as const).map(
    (status, index) => ({
      key: `guardrail-${index}`,
      label: `Operational guardrail ${index + 1}`,
      status,
      detail: "Review the recorded inference and human decision evidence",
      actionHref: "/clerk/health",
    }),
  ),
};

export const operatorResponses = {
  "/api/operator/gate-metrics": activation,
  "/api/operator/buyer-pilots": buyers,
  "/api/operator/compliance-operations": cases,
  "/api/operator/integration-reliability": reliability,
  "/api/operator/evidence-vault": evidence,
  "/api/operator/clerk-assurance": clerk,
};
