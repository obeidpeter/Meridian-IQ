import { sql } from "drizzle-orm";
import {
  getDb,
  migrations,
  operationalHeartbeatsTable,
  outboxTable,
  pool,
} from "@workspace/db";
import { API_CONTRACT_VERSION } from "@workspace/api-zod";
import { ADVISORY_EMAIL } from "@workspace/format";
import {
  deployedBuildRevision,
  expectedBuildRevision,
  revisionsMatch,
} from "../../lib/build";
import { getReadiness } from "../../lib/readiness";
import { describeKeyRing, legacyTokenPathEnabled } from "../../lib/op-token";
import { railTransportSummary } from "../rails/adapter";
import { listFlags } from "../flags/flags";
import { invoiceRoomSecurityConfiguration } from "../invoice-room/security";
import { getCreditGovernance } from "../credit/governance";

export type ReleaseCheckStatus = "pass" | "warning" | "blocked";

export interface ReleaseReadinessCheck {
  key: string;
  label: string;
  status: ReleaseCheckStatus;
  summary: string;
  detail: Record<string, unknown> | null;
}

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

function heartbeatCheck(
  key: string,
  label: string,
  lastSucceededAt: Date | null | undefined,
  maxAgeMs: number,
  production: boolean,
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
  const signedAgeMs = Date.now() - lastSucceededAt.getTime();
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
    detail: {
      lastSucceededAt: lastSucceededAt.toISOString(),
      ageMs,
      maxAgeMs,
    },
  };
}

function evidenceCheck(input: {
  key: string;
  label: string;
  envName: string;
  maxAgeMs: number;
  production: boolean;
  detail?: Record<string, unknown>;
}): ReleaseReadinessCheck {
  const raw = process.env[input.envName]?.trim();
  const verifiedAt = raw ? new Date(raw) : null;
  const valid = verifiedAt !== null && Number.isFinite(verifiedAt.getTime());
  const signedAgeMs = valid ? Date.now() - verifiedAt.getTime() : null;
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

export async function getReleaseReadiness() {
  const production = process.env.NODE_ENV === "production";
  const actualRevision = deployedBuildRevision();
  const expectedRevision = expectedBuildRevision();
  const checks: ReleaseReadinessCheck[] = [];

  checks.push({
    key: "deployment_revision",
    label: "Deployment revision",
    status:
      expectedRevision && revisionsMatch(actualRevision, expectedRevision)
        ? "pass"
        : production
          ? "blocked"
          : "warning",
    summary: expectedRevision
      ? revisionsMatch(actualRevision, expectedRevision)
        ? "The running build matches the expected Git revision."
        : "The running build does not match the expected Git revision."
      : "EXPECTED_BUILD_REVISION is not configured.",
    detail: { actualRevision, expectedRevision },
  });

  const migrationResult = await pool.query<{
    count: number;
    max_version: number;
  }>(
    "SELECT count(*)::int AS count, coalesce(max(version), 0)::int AS max_version FROM _schema_migrations",
  );
  const migration = migrationResult.rows[0] ?? { count: 0, max_version: 0 };
  const expectedMax = Math.max(...migrations.map((item) => item.version));
  const migrationsCurrent =
    Number(migration.count) === migrations.length &&
    Number(migration.max_version) === expectedMax;
  checks.push({
    key: "database_migrations",
    label: "Database migrations",
    status: migrationsCurrent ? "pass" : "blocked",
    summary: migrationsCurrent
      ? `All ${migrations.length} guardrail migrations are applied.`
      : `Database has ${migration.count}/${migrations.length} migrations; latest is ${migration.max_version}/${expectedMax}.`,
    detail: {
      appliedCount: Number(migration.count),
      expectedCount: migrations.length,
      appliedMaxVersion: Number(migration.max_version),
      expectedMaxVersion: expectedMax,
    },
  });

  const heartbeats = await getDb().select().from(operationalHeartbeatsTable);
  const byKey = new Map(heartbeats.map((row) => [row.key, row]));
  checks.push(
    heartbeatCheck(
      "scheduled_work",
      "Scheduled work",
      byKey.get("scheduled_work")?.lastSucceededAt,
      envInt("SCHEDULED_WORK_MAX_AGE_MS", 10 * 60_000),
      production,
    ),
  );
  checks.push(
    heartbeatCheck(
      "backup",
      "Database backup",
      byKey.get("backup")?.lastSucceededAt,
      envInt("BACKUP_MAX_AGE_MS", 26 * 60 * 60_000),
      production,
    ),
  );
  checks.push(
    heartbeatCheck(
      "restore_drill",
      "Restore drill",
      byKey.get("restore_drill")?.lastSucceededAt,
      envInt("RESTORE_DRILL_MAX_AGE_MS", 31 * 24 * 60 * 60_000),
      production,
    ),
  );

  checks.push(
    evidenceCheck({
      key: "advisory_inbox",
      label: "Advisory inbox",
      envName: "ADVISORY_INBOX_VERIFIED_AT",
      maxAgeMs: envInt("ADVISORY_INBOX_MAX_AGE_MS", 90 * 24 * 60 * 60_000),
      production,
      detail: { address: ADVISORY_EMAIL },
    }),
  );
  checks.push(
    evidenceCheck({
      key: "moderated_usability",
      label: "Moderated usability validation",
      envName: "USABILITY_VALIDATED_AT",
      maxAgeMs: envInt("USABILITY_MAX_AGE_MS", 180 * 24 * 60 * 60_000),
      production,
      detail: {
        evidenceReference: process.env.USABILITY_EVIDENCE_REF?.trim() || null,
      },
    }),
  );

  const [queue] = await getDb()
    .select({
      pending: sql<number>`count(*) FILTER (WHERE status = 'pending')::int`,
      processing: sql<number>`count(*) FILTER (WHERE status = 'processing')::int`,
      dead: sql<number>`count(*) FILTER (WHERE status = 'dead')::int`,
      oldestPendingSeconds: sql<number>`coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending')), 0)::float`,
    })
    .from(outboxTable);
  const oldestPendingSeconds = Number(queue?.oldestPendingSeconds ?? 0);
  const queueBlocked =
    oldestPendingSeconds > envInt("OUTBOX_RELEASE_MAX_AGE_SECONDS", 900);
  const queueWarning =
    Number(queue?.dead ?? 0) > 0 || Number(queue?.processing ?? 0) > 0;
  checks.push({
    key: "pipeline",
    label: "Submission pipeline",
    status: queueBlocked ? "blocked" : queueWarning ? "warning" : "pass",
    summary: queueBlocked
      ? "The oldest pending event exceeds the release threshold."
      : queueWarning
        ? "The pipeline has operator-visible work to review."
        : "No dead or in-flight events are blocking release.",
    detail: {
      pending: Number(queue?.pending ?? 0),
      processing: Number(queue?.processing ?? 0),
      dead: Number(queue?.dead ?? 0),
      oldestPendingSeconds,
    },
  });

  const metricsSecured = describeKeyRing("METRICS_TOKEN").configured;
  const schedulerSecured = describeKeyRing("SWEEP_TOKEN").configured;
  const signedOnly = !legacyTokenPathEnabled();
  const totpRoles = new Set(
    (process.env.TOTP_REQUIRED_ROLES ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const privilegedMfa =
    totpRoles.has("operator") &&
    totpRoles.has("firm_admin") &&
    totpRoles.has("bank_user");
  const securityClean =
    signedOnly && metricsSecured && schedulerSecured && privilegedMfa;
  checks.push({
    key: "security_configuration",
    label: "Security configuration",
    status: securityClean ? "pass" : production ? "blocked" : "warning",
    summary: securityClean
      ? "Machine endpoints require signatures and privileged roles require TOTP."
      : "One or more production security controls are not configured.",
    detail: {
      signedMachineRequestsOnly: signedOnly,
      metricsProtected: metricsSecured,
      schedulerProtected: schedulerSecured,
      privilegedRolesRequireTotp: privilegedMfa,
      requiredTotpRoles: ["operator", "firm_admin", "bank_user"],
    },
  });

  const rail = railTransportSummary();
  const railsConfigured = Object.values(rail.rails).every(
    (item) => item.configured,
  );
  const accreditationConfirmed =
    process.env.RAIL_ACCREDITATION_CONFIRMED?.trim().toLowerCase() === "true";
  const requireLive =
    process.env.REQUIRE_LIVE_RAILS?.trim().toLowerCase() === "true";
  const liveReady =
    rail.transport === "http" &&
    rail.environment === "live" &&
    railsConfigured &&
    accreditationConfirmed;
  checks.push({
    key: "authority_rails",
    label: "Authority rails",
    status: liveReady ? "pass" : requireLive ? "blocked" : "warning",
    summary: liveReady
      ? "Both live HTTP rails are configured and accreditation is confirmed."
      : "The deployment remains on a sandbox, simulator, partial rail configuration, or unconfirmed accreditation.",
    detail: {
      transport: rail.transport,
      environment: rail.environment,
      configuredRailCount: Object.values(rail.rails).filter(
        (item) => item.configured,
      ).length,
      accreditationConfirmed,
      liveRailsRequired: requireLive,
    },
  });

  const flags = await listFlags();
  const violations = flags
    .filter((flag) => flag.enabled && flag.unmetPrerequisites.length > 0)
    .map((flag) => ({ key: flag.key, missing: flag.unmetPrerequisites }));
  checks.push({
    key: "feature_dependencies",
    label: "Feature dependencies",
    status: violations.length === 0 ? "pass" : "blocked",
    summary:
      violations.length === 0
        ? "Every enabled platform feature has its prerequisites."
        : `${violations.length} enabled feature(s) have missing prerequisites.`,
    detail: { violations },
  });

  const invoiceRoomFlag = flags.find((flag) => flag.key === "invoice_room");
  const invoiceRoomActive = Boolean(
    invoiceRoomFlag?.enabled || invoiceRoomFlag?.overrideCount,
  );
  const invoiceRoomConfiguration = invoiceRoomSecurityConfiguration();
  const invoiceRoomReady =
    invoiceRoomConfiguration.encryptionKeyConfigured &&
    invoiceRoomConfiguration.publicUrlConfigured;
  checks.push({
    key: "invoice_room_configuration",
    label: "Invoice Room security",
    status:
      !invoiceRoomActive || invoiceRoomReady
        ? "pass"
        : production
          ? "blocked"
          : "warning",
    summary: !invoiceRoomActive
      ? "Invoice Room is dark on this deployment."
      : invoiceRoomReady
        ? "Share credentials and the public link origin are configured."
        : "Invoice Room is enabled without all required production security settings.",
    detail: {
      featureActive: invoiceRoomActive,
      encryptionKeyConfigured: invoiceRoomConfiguration.encryptionKeyConfigured,
      publicUrlConfigured: invoiceRoomConfiguration.publicUrlConfigured,
    },
  });

  const creditFlag = flags.find((flag) => flag.key === "credit_readiness");
  const bankDataRoomFlag = flags.find((flag) => flag.key === "bank_data_room");
  const creditPilotActive = Boolean(creditFlag?.overrideCount);
  const bankDataRoomActive = Boolean(bankDataRoomFlag?.enabled);
  const creditGovernance = await getCreditGovernance();
  checks.push({
    key: "credit_data_room_governance",
    label: "Credit Data Room governance",
    status: bankDataRoomActive
      ? creditGovernance.activationReady
        ? "pass"
        : "blocked"
      : creditPilotActive
        ? "warning"
        : "pass",
    summary: bankDataRoomActive
      ? creditGovernance.activationReady
        ? "The bank Data Room is active and every R3 activation gate is evidenced."
        : "The bank Data Room is active without every R3 activation gate."
      : creditPilotActive
        ? "Credit-readiness pilots are collecting evidence; the bank Data Room remains dark."
        : "The R3 credit perimeter and bank Data Room are dark.",
    detail: {
      creditReadinessEnabled: creditFlag?.enabled ?? false,
      creditPilotFirms: creditFlag?.overrideCount ?? 0,
      bankDataRoomEnabled: bankDataRoomActive,
      activationReady: creditGovernance.activationReady,
      blockers: creditGovernance.blockers,
      observableBusinesses:
        creditGovernance.activationEvidence.observableBusinesses,
      targetBusinesses: creditGovernance.activationEvidence.targetBusinesses,
      latestBacktestPassed: creditGovernance.latestBacktest?.passed ?? false,
    },
  });

  const readiness = getReadiness();
  checks.push({
    key: "service_readiness",
    label: "Service readiness",
    status: readiness.ready ? "pass" : "blocked",
    summary: readiness.ready
      ? "The application bootstrap gate is ready."
      : `The application is not ready: ${readiness.reason}.`,
    detail: { reason: readiness.reason },
  });

  const status = checks.some((check) => check.status === "blocked")
    ? "blocked"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "ready";
  return {
    status,
    generatedAt: new Date().toISOString(),
    buildRevision: actualRevision,
    expectedBuildRevision: expectedRevision,
    contractVersion: API_CONTRACT_VERSION,
    checks,
  };
}
