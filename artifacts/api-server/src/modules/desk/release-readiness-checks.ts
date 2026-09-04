export type ReleaseCheckStatus = "pass" | "warning" | "blocked";

export interface ReleaseReadinessCheck {
  key: string;
  label: string;
  status: ReleaseCheckStatus;
  summary: string;
  detail: Record<string, unknown> | null;
}

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

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
): ReleaseReadinessCheck {
  if (!lastSucceededAt) {
    return {
      key,
      label,
      status: production ? "blocked" : "warning",
      summary: "No successful run has been recorded.",
      detail: { maxAgeMinutes: Math.round(maxAgeMs / 60_000) },
    };
  }
  const signedAgeMs = now - lastSucceededAt.getTime();
  const future = signedAgeMs < -MAX_CLOCK_SKEW_MS;
  const ageMs = Math.max(0, signedAgeMs);
  const current = !future && ageMs <= maxAgeMs;
  return {
    key,
    label,
    status: current ? "pass" : production ? "blocked" : "warning",
    summary: future
      ? "The recorded success time is unexpectedly in the future."
      : current
        ? `Last successful run ${Math.round(ageMs / 60_000)} minute(s) ago.`
        : `Last successful run is stale (${Math.round(ageMs / 60_000)} minute(s) ago).`,
    detail: { lastSucceededAt: lastSucceededAt.toISOString(), ageMs, maxAgeMs },
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
}): ReleaseReadinessCheck {
  const raw = input.raw?.trim();
  const verifiedAt = raw ? new Date(raw) : null;
  const valid = verifiedAt !== null && Number.isFinite(verifiedAt.getTime());
  const signedAgeMs = valid
    ? (input.now ?? Date.now()) - verifiedAt.getTime()
    : null;
  const future = signedAgeMs !== null && signedAgeMs < -MAX_CLOCK_SKEW_MS;
  const ageMs = signedAgeMs === null ? null : Math.max(0, signedAgeMs);
  const current = ageMs !== null && !future && ageMs <= input.maxAgeMs;
  return {
    key: input.key,
    label: input.label,
    status: current ? "pass" : input.production ? "blocked" : "warning",
    summary: current
      ? `Evidence verified ${Math.round(ageMs / 86_400_000)} day(s) ago.`
      : future
        ? `${input.envName} is unexpectedly in the future.`
        : !raw
          ? `${input.envName} is not configured.`
          : !valid
            ? `${input.envName} is not a valid ISO date-time.`
            : `Evidence is stale (${Math.round((ageMs ?? 0) / 86_400_000)} day(s) old).`,
    detail: {
      ...input.detail,
      verifiedAt: valid ? verifiedAt.toISOString() : null,
      maxAgeDays: Math.round(input.maxAgeMs / 86_400_000),
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
      ? "Machine endpoints require signatures and privileged roles require TOTP."
      : "One or more production security controls are not configured.",
    detail: {
      signedMachineRequestsOnly: input.signedOnly,
      metricsProtected: input.metricsSecured,
      schedulerProtected: input.schedulerSecured,
      privilegedRolesRequireTotp: input.privilegedMfa,
      requiredTotpRoles: ["operator", "firm_admin", "bank_user"],
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
      ? "Both live HTTP rails are configured and accreditation is confirmed."
      : "The deployment remains on a sandbox, simulator, partial rail configuration, or unconfirmed accreditation.",
    detail: {
      transport: input.transport,
      environment: input.environment,
      configuredRailCount: input.configuredRailCount,
      accreditationConfirmed: input.accreditationConfirmed,
      liveRailsRequired: input.requireLive,
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
