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
import {
  authorityRailsCheck,
  creditDataRoomCheck,
  deploymentRevisionCheck,
  evidenceCheck,
  featureDependenciesCheck,
  heartbeatCheck,
  invoiceRoomCheck,
  migrationCheck,
  pipelineCheck,
  releaseStatus,
  securityConfigurationCheck,
  serviceReadinessCheck,
  type ReleaseReadinessCheck,
} from "./release-readiness-checks";

export type {
  ReleaseCheckStatus,
  ReleaseReadinessCheck,
} from "./release-readiness-checks";

const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export async function getReleaseReadiness() {
  const now = Date.now();
  const production = process.env.NODE_ENV === "production";
  const actualRevision = deployedBuildRevision();
  const expectedRevision = expectedBuildRevision();
  const checks: ReleaseReadinessCheck[] = [];

  checks.push(
    deploymentRevisionCheck(
      actualRevision,
      expectedRevision,
      Boolean(
        expectedRevision && revisionsMatch(actualRevision, expectedRevision),
      ),
      production,
    ),
  );

  const migrationResult = await pool.query<{
    count: number;
    max_version: number;
  }>(
    "SELECT count(*)::int AS count, coalesce(max(version), 0)::int AS max_version FROM _schema_migrations",
  );
  const migration = migrationResult.rows[0] ?? { count: 0, max_version: 0 };
  const expectedMax = Math.max(...migrations.map((item) => item.version));
  checks.push(
    migrationCheck({
      appliedCount: Number(migration.count),
      expectedCount: migrations.length,
      appliedMaxVersion: Number(migration.max_version),
      expectedMaxVersion: expectedMax,
    }),
  );

  const heartbeats = await getDb().select().from(operationalHeartbeatsTable);
  const byKey = new Map(heartbeats.map((row) => [row.key, row]));
  checks.push(
    heartbeatCheck(
      "scheduled_work",
      "Scheduled work",
      byKey.get("scheduled_work")?.lastSucceededAt,
      envInt("SCHEDULED_WORK_MAX_AGE_MS", 10 * 60_000),
      production,
      now,
      byKey.get("scheduled_work"),
    ),
  );
  checks.push(
    heartbeatCheck(
      "backup",
      "Database backup",
      byKey.get("backup")?.lastSucceededAt,
      envInt("BACKUP_MAX_AGE_MS", 26 * 60 * 60_000),
      production,
      now,
      byKey.get("backup"),
    ),
  );
  checks.push(
    heartbeatCheck(
      "restore_drill",
      "Restore drill",
      byKey.get("restore_drill")?.lastSucceededAt,
      envInt("RESTORE_DRILL_MAX_AGE_MS", 31 * 24 * 60 * 60_000),
      production,
      now,
      byKey.get("restore_drill"),
    ),
  );

  checks.push(
    evidenceCheck({
      key: "advisory_inbox",
      label: "Advisory inbox",
      envName: "ADVISORY_INBOX_VERIFIED_AT",
      raw: process.env.ADVISORY_INBOX_VERIFIED_AT,
      maxAgeMs: envInt("ADVISORY_INBOX_MAX_AGE_MS", 90 * 24 * 60 * 60_000),
      production,
      detail: { address: ADVISORY_EMAIL },
      now,
      owner: "Advisory operations",
      remediation:
        "Complete an approved receive, triage and reply test; retain private evidence before setting ADVISORY_INBOX_VERIFIED_AT.",
    }),
  );
  checks.push(
    evidenceCheck({
      key: "moderated_usability",
      label: "Moderated usability validation",
      envName: "USABILITY_VALIDATED_AT",
      raw: process.env.USABILITY_VALIDATED_AT,
      maxAgeMs: envInt("USABILITY_MAX_AGE_MS", 180 * 24 * 60 * 60_000),
      production,
      now,
      owner: "Product research",
      requireReference: true,
      remediation:
        "Complete moderated participant sessions and retain the findings; record USABILITY_VALIDATED_AT and USABILITY_EVIDENCE_REF only afterwards.",
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
  checks.push(
    pipelineCheck(queue, envInt("OUTBOX_RELEASE_MAX_AGE_SECONDS", 900)),
  );

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
  checks.push(
    securityConfigurationCheck({
      signedOnly,
      metricsSecured,
      schedulerSecured,
      privilegedMfa,
      production,
    }),
  );

  const rail = railTransportSummary();
  const railsConfigured = Object.values(rail.rails).every(
    (item) => item.configured,
  );
  const accreditationConfirmed =
    process.env.RAIL_ACCREDITATION_CONFIRMED?.trim().toLowerCase() === "true";
  const requireLive =
    process.env.REQUIRE_LIVE_RAILS?.trim().toLowerCase() === "true";
  checks.push(
    authorityRailsCheck({
      transport: rail.transport,
      environment: rail.environment,
      railsConfigured,
      configuredRailCount: Object.values(rail.rails).filter(
        (item) => item.configured,
      ).length,
      accreditationConfirmed,
      requireLive,
    }),
  );

  const flags = await listFlags();
  const violations = flags
    .filter((flag) => flag.enabled && flag.unmetPrerequisites.length > 0)
    .map((flag) => ({ key: flag.key, missing: flag.unmetPrerequisites }));
  checks.push(featureDependenciesCheck(violations));

  const invoiceRoomFlag = flags.find((flag) => flag.key === "invoice_room");
  const invoiceRoomActive = Boolean(
    invoiceRoomFlag?.enabled || invoiceRoomFlag?.overrideCount,
  );
  const invoiceRoomConfiguration = invoiceRoomSecurityConfiguration();
  checks.push(
    invoiceRoomCheck({
      active: invoiceRoomActive,
      encryptionKeyConfigured: invoiceRoomConfiguration.encryptionKeyConfigured,
      publicUrlConfigured: invoiceRoomConfiguration.publicUrlConfigured,
      production,
    }),
  );

  const creditFlag = flags.find((flag) => flag.key === "credit_readiness");
  const bankDataRoomFlag = flags.find((flag) => flag.key === "bank_data_room");
  const bankDataRoomActive = Boolean(bankDataRoomFlag?.enabled);
  const creditGovernance = await getCreditGovernance();
  checks.push(
    creditDataRoomCheck({
      creditReadinessEnabled: creditFlag?.enabled ?? false,
      creditPilotFirms: creditFlag?.overrideCount ?? 0,
      bankDataRoomActive,
      activationReady: creditGovernance.activationReady,
      blockers: creditGovernance.blockers,
      observableBusinesses:
        creditGovernance.activationEvidence.observableBusinesses,
      targetBusinesses: creditGovernance.activationEvidence.targetBusinesses,
      latestBacktestPassed: creditGovernance.latestBacktest?.passed ?? false,
    }),
  );

  const readiness = getReadiness();
  checks.push(serviceReadinessCheck(readiness));

  return {
    status: releaseStatus(checks),
    generatedAt: new Date(now).toISOString(),
    buildRevision: actualRevision,
    expectedBuildRevision: expectedRevision,
    contractVersion: API_CONTRACT_VERSION,
    checks,
  };
}
