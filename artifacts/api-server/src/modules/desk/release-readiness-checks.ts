export type ReleaseCheckStatus = "pass" | "warning" | "blocked";

export interface ReleaseReadinessCheck {
  key: string;
  label: string;
  status: ReleaseCheckStatus;
  summary: string;
  detail: Record<string, unknown> | null;
}

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface HeartbeatEvidence {
  lastSucceededAt?: Date | null;
  lastFailedAt?: Date | null;
  lastError?: string | null;
  metadata?: Record<string, unknown> | null;
}

const operationalActions: Record<
  string,
  { owner: string; remediation: string }
> = {
  scheduled_work: {
    owner: "Platform operations",
    remediation:
      "Inspect the approved scheduler and failed passes; rerun the existing ops:sweep tool after remediation.",
  },
  backup: {
    owner: "Database operations",
    remediation:
      "Run ops:backup on an approved private runner, verify the retained manifest, and confirm encrypted private off-box retention separately.",
  },
  restore_drill: {
    owner: "Database operations",
    remediation:
      "Run ops:restore-drill with a trusted retained manifest and a fresh, explicitly disposable isolated database; inspect catalog and row-count verification.",
  },
};

function isoDate(value: Date | null | undefined): string | null {
  return value && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function recoveryProvenance(
  key: string,
  metadata: Record<string, unknown> | null | undefined,
  succeededAt: number,
  maxAgeMs: number,
  now: number,
): "current" | "stale" | "unverified" {
  if (key !== "backup" && key !== "restore_drill") return "current";
  const hashes =
    key === "backup"
      ? ["sha256", "snapshotSha256", "manifestSha256"]
      : ["backupSha256", "snapshotSha256", "backupManifestSha256"];
  if (
    metadata?.evidenceVersion !== 2 ||
    hashes.some(
      (field) =>
        typeof metadata[field] !== "string" ||
        !/^[a-f0-9]{64}$/.test(metadata[field]),
    )
  )
    return "unverified";
  const rawCreatedAt =
    metadata[key === "backup" ? "createdAt" : "backupCreatedAt"];
  const createdAt =
    typeof rawCreatedAt === "string" ? Date.parse(rawCreatedAt) : NaN;
  if (
    !Number.isFinite(createdAt) ||
    createdAt > succeededAt ||
    createdAt > now + MAX_CLOCK_SKEW_MS
  )
    return "unverified";
  if (key === "backup") {
    if (
      !Number.isSafeInteger(metadata.bytes) ||
      Number(metadata.bytes) <= 0 ||
      !Number.isSafeInteger(metadata.tocEntries) ||
      Number(metadata.tocEntries) <= 0
    )
      return "unverified";
    if (now - createdAt > maxAgeMs) return "stale";
  } else if (
    metadata.securityCatalogVerified !== true ||
    metadata.allTableCountsVerified !== true ||
    succeededAt - createdAt > 24 * 60 * 60_000
  ) {
    return "unverified";
  }
  return "current";
}

export function deploymentRevisionCheck(
  actualRevision: string | null,
  expectedRevision: string | null,
  matches: boolean,
  production: boolean,
): ReleaseReadinessCheck {
  return {
    key: "deployment_revision",
    label: "Deployment revision",
    status:
      expectedRevision && matches ? "pass" : production ? "blocked" : "warning",
    summary: expectedRevision
      ? matches
        ? "The running build matches the expected Git revision."
        : "The running build does not match the expected Git revision."
      : "EXPECTED_BUILD_REVISION is not configured.",
    detail: { actualRevision, expectedRevision },
  };
}

export function migrationCheck(input: {
  appliedCount: number;
  expectedCount: number;
  appliedMaxVersion: number;
  expectedMaxVersion: number;
}): ReleaseReadinessCheck {
  const current =
    input.appliedCount === input.expectedCount &&
    input.appliedMaxVersion === input.expectedMaxVersion;
  return {
    key: "database_migrations",
    label: "Database migrations",
    status: current ? "pass" : "blocked",
    summary: current
      ? `All ${input.expectedCount} guardrail migrations are applied.`
      : `Database has ${input.appliedCount}/${input.expectedCount} migrations; latest is ${input.appliedMaxVersion}/${input.expectedMaxVersion}.`,
    detail: input,
  };
}

export function heartbeatCheck(
  key: string,
  label: string,
  lastSucceededAt: Date | null | undefined,
  maxAgeMs: number,
  production: boolean,
  now = Date.now(),
  evidence: HeartbeatEvidence = {},
): ReleaseReadinessCheck {
  const success = isoDate(lastSucceededAt);
  const failure = isoDate(evidence.lastFailedAt);
  const signedAgeMs = success ? now - Date.parse(success) : NaN;
  const future = signedAgeMs < -MAX_CLOCK_SKEW_MS;
  const ageMs = success ? Math.max(0, signedAgeMs) : null;
  const failed =
    Boolean(evidence.lastError) ||
    Boolean(
      failure && (!success || Date.parse(failure) >= Date.parse(success)),
    );
  const invalid =
    (lastSucceededAt != null && !success) ||
    (evidence.lastFailedAt != null && !failure) ||
    future;
  const provenance = success
    ? recoveryProvenance(
        key,
        evidence.metadata,
        Date.parse(success),
        maxAgeMs,
        now,
      )
    : "unverified";
  const evidenceState = failed
    ? "failed"
    : invalid
      ? "invalid"
      : !success
        ? "missing"
        : ageMs! > maxAgeMs
          ? "stale"
          : provenance;
  const summaries = {
    failed:
      "A failed run is recorded; the last success does not clear the failure.",
    invalid:
      "The recorded evidence time is invalid or unexpectedly in the future.",
    missing: "No successful run has been recorded.",
    stale: "The last successful run or backup snapshot is stale.",
    unverified:
      "The success timestamp lacks valid version-2 recovery provenance.",
    current: `Last successful run ${Math.round((ageMs ?? 0) / 60_000)} minute(s) ago.`,
  };
  return {
    key,
    label,
    status:
      evidenceState === "current" ? "pass" : production ? "blocked" : "warning",
    summary: summaries[evidenceState],
    // Never expose raw errors, filenames, database identities or arbitrary metadata.
    detail: {
      evidenceState,
      evidenceSource: "operational_heartbeats",
      lastSucceededAt: success,
      lastFailedAt: failure,
      ageMs,
      maxAgeMs,
      provenanceVerified: success !== null && provenance !== "unverified",
      ...(key === "backup" ? { offBoxRetentionVerified: false } : {}),
      ...operationalActions[key],
    },
  };
}

export function evidenceCheck(input: {
  key: string;
  label: string;
  envName: string;
  raw: string | undefined;
  maxAgeMs: number;
  production: boolean;
  detail?: Record<string, unknown>;
  now?: number;
  owner?: string;
  remediation?: string;
  requireReference?: boolean;
}): ReleaseReadinessCheck {
  const raw = input.raw?.trim();
  const verifiedAt = raw ? new Date(raw) : null;
  const valid =
    verifiedAt !== null &&
    Number.isFinite(verifiedAt.getTime()) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      raw!,
    );
  const signedAgeMs = valid
    ? (input.now ?? Date.now()) - verifiedAt.getTime()
    : null;
  const future = signedAgeMs !== null && signedAgeMs < -MAX_CLOCK_SKEW_MS;
  const ageMs = signedAgeMs === null ? null : Math.max(0, signedAgeMs);
  const hasReference =
    typeof input.detail?.evidenceReference === "string" &&
    input.detail.evidenceReference.trim().length > 0;
  const evidenceState = !raw
    ? "missing"
    : !valid || future
      ? "invalid"
      : ageMs! > input.maxAgeMs
        ? "stale"
        : input.requireReference && !hasReference
          ? "unverified"
          : "current";
  const current = evidenceState === "current";
  return {
    key: input.key,
    label: input.label,
    status: current ? "pass" : input.production ? "blocked" : "warning",
    summary: current
      ? `Operator-attested evidence dated ${Math.round(ageMs! / 86_400_000)} day(s) ago; not independently verified by this service.`
      : future
        ? `${input.envName} is unexpectedly in the future.`
        : !raw
          ? "No dated evidence has been recorded."
          : !valid
            ? `${input.envName} is not a valid ISO date-time.`
            : evidenceState === "unverified"
              ? "The evidence date has no supporting report reference."
              : `Evidence is stale (${Math.round((ageMs ?? 0) / 86_400_000)} day(s) old).`,
    detail: {
      ...input.detail,
      verifiedAt: valid ? verifiedAt.toISOString() : null,
      maxAgeDays: Math.round(input.maxAgeMs / 86_400_000),
      evidenceState,
      evidenceSource: "operator_attestation",
      owner: input.owner ?? "Deployment owner",
      remediation:
        input.remediation ??
        "Complete the approved verification and retain its supporting evidence before recording a date.",
    },
  };
}

export function pipelineCheck(
  queue:
    | {
        pending?: number;
        processing?: number;
        dead?: number;
        oldestPendingSeconds?: number;
      }
    | undefined,
  maxAgeSeconds: number,
): ReleaseReadinessCheck {
  const oldestPendingSeconds = Number(queue?.oldestPendingSeconds ?? 0);
  const blocked = oldestPendingSeconds > maxAgeSeconds;
  const warning =
    Number(queue?.dead ?? 0) > 0 || Number(queue?.processing ?? 0) > 0;
  return {
    key: "pipeline",
    label: "Submission pipeline",
    status: blocked ? "blocked" : warning ? "warning" : "pass",
    summary: blocked
      ? "The oldest pending event exceeds the release threshold."
      : warning
        ? "The pipeline has operator-visible work to review."
        : "No dead or in-flight events are blocking release.",
    detail: {
      pending: Number(queue?.pending ?? 0),
      processing: Number(queue?.processing ?? 0),
      dead: Number(queue?.dead ?? 0),
      oldestPendingSeconds,
    },
  };
}

export function securityConfigurationCheck(input: {
  signedOnly: boolean;
  metricsSecured: boolean;
  schedulerSecured: boolean;
  privilegedMfa: boolean;
  production: boolean;
}): ReleaseReadinessCheck {
  const clean =
    input.signedOnly &&
    input.metricsSecured &&
    input.schedulerSecured &&
    input.privilegedMfa;
  return {
    key: "security_configuration",
    label: "Security configuration",
    status: clean ? "pass" : input.production ? "blocked" : "warning",
    summary: clean
      ? "Signature and TOTP controls are configured; external authentication has not been verified by this check."
      : "One or more production security controls are not configured.",
    detail: {
      signedMachineRequestsOnly: input.signedOnly,
      metricsProtected: input.metricsSecured,
      schedulerProtected: input.schedulerSecured,
      privilegedRolesRequireTotp: input.privilegedMfa,
      requiredTotpRoles: ["operator", "firm_admin", "bank_user"],
      evidenceState: "configuration_only",
      owner: "Platform operations",
      remediation:
        "Run the read-only operational-check runner from an approved external host to verify signed metrics access.",
    },
  };
}

export function authorityRailsCheck(input: {
  transport: string;
  environment: string;
  railsConfigured: boolean;
  configuredRailCount: number;
  accreditationConfirmed: boolean;
  requireLive: boolean;
}): ReleaseReadinessCheck {
  const ready =
    input.transport === "http" &&
    input.environment === "live" &&
    input.railsConfigured &&
    input.accreditationConfirmed;
  return {
    key: "authority_rails",
    label: "Authority rails",
    status: ready ? "pass" : input.requireLive ? "blocked" : "warning",
    summary: ready
      ? "Both live HTTP rails are configured and accreditation is attested; no provider transaction is verified by this check."
      : "The deployment remains on a sandbox, simulator, partial rail configuration, or unconfirmed accreditation.",
    detail: {
      transport: input.transport,
      environment: input.environment,
      configuredRailCount: input.configuredRailCount,
      accreditationConfirmed: input.accreditationConfirmed,
      liveRailsRequired: input.requireLive,
      evidenceState: "configuration_only",
      owner: "Provider integration owner",
      remediation:
        "Obtain provider credentials and approval, then retain real provider validation evidence before claiming live readiness.",
    },
  };
}

export function featureDependenciesCheck(
  violations: Array<{ key: string; missing: string[] }>,
): ReleaseReadinessCheck {
  return {
    key: "feature_dependencies",
    label: "Feature dependencies",
    status: violations.length === 0 ? "pass" : "blocked",
    summary:
      violations.length === 0
        ? "Every enabled platform feature has its prerequisites."
        : `${violations.length} enabled feature(s) have missing prerequisites.`,
    detail: { violations },
  };
}

export function invoiceRoomCheck(input: {
  active: boolean;
  encryptionKeyConfigured: boolean;
  publicUrlConfigured: boolean;
  production: boolean;
}): ReleaseReadinessCheck {
  const ready = input.encryptionKeyConfigured && input.publicUrlConfigured;
  return {
    key: "invoice_room_configuration",
    label: "Invoice Room security",
    status:
      !input.active || ready
        ? "pass"
        : input.production
          ? "blocked"
          : "warning",
    summary: !input.active
      ? "Invoice Room is dark on this deployment."
      : ready
        ? "Share credentials and the public link origin are configured."
        : "Invoice Room is enabled without all required production security settings.",
    detail: {
      featureActive: input.active,
      encryptionKeyConfigured: input.encryptionKeyConfigured,
      publicUrlConfigured: input.publicUrlConfigured,
    },
  };
}

export function creditDataRoomCheck(input: {
  creditReadinessEnabled: boolean;
  creditPilotFirms: number;
  bankDataRoomActive: boolean;
  activationReady: boolean;
  blockers: unknown;
  observableBusinesses: number;
  targetBusinesses: number;
  latestBacktestPassed: boolean;
}): ReleaseReadinessCheck {
  const pilotActive = input.creditPilotFirms > 0;
  return {
    key: "credit_data_room_governance",
    label: "Credit Data Room governance",
    status: input.bankDataRoomActive
      ? input.activationReady
        ? "pass"
        : "blocked"
      : pilotActive
        ? "warning"
        : "pass",
    summary: input.bankDataRoomActive
      ? input.activationReady
        ? "The bank Data Room is active and every R3 activation gate is evidenced."
        : "The bank Data Room is active without every R3 activation gate."
      : pilotActive
        ? "Credit-readiness pilots are collecting evidence; the bank Data Room remains dark."
        : "The R3 credit perimeter and bank Data Room are dark.",
    detail: {
      creditReadinessEnabled: input.creditReadinessEnabled,
      creditPilotFirms: input.creditPilotFirms,
      bankDataRoomEnabled: input.bankDataRoomActive,
      activationReady: input.activationReady,
      blockers: input.blockers,
      observableBusinesses: input.observableBusinesses,
      targetBusinesses: input.targetBusinesses,
      latestBacktestPassed: input.latestBacktestPassed,
    },
  };
}

export function serviceReadinessCheck(readiness: {
  ready: boolean;
  reason: string;
}): ReleaseReadinessCheck {
  return {
    key: "service_readiness",
    label: "Service readiness",
    status: readiness.ready ? "pass" : "blocked",
    summary: readiness.ready
      ? "The application bootstrap gate is ready."
      : `The application is not ready: ${readiness.reason}.`,
    detail: { reason: readiness.reason },
  };
}

export function releaseStatus(
  checks: readonly ReleaseReadinessCheck[],
): "ready" | "warning" | "blocked" {
  if (checks.some((check) => check.status === "blocked")) return "blocked";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ready";
}
