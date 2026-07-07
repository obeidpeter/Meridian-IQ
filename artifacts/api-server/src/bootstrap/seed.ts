import {
  getDb,
  runInBypassContext,
  featureFlagsTable,
  schemaVersionsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { seedCatalogue } from "../modules/catalogue/catalogue";

// Release-tagged feature flags (PL-02). Everything past R0 ships dark; a dark
// feature is unreachable until an operator flips the flag (or a per-firm
// override activates it on recorded consent).
const FLAGS: {
  key: string;
  enabled: boolean;
  releaseTag: string;
  description: string;
}[] = [
  { key: "invoice_lifecycle", enabled: true, releaseTag: "R0", description: "Core invoice draft/validate/submit lifecycle" },
  { key: "advisory_engagements", enabled: true, releaseTag: "R0", description: "Advisory engagement spine" },
  { key: "consent_ledger", enabled: true, releaseTag: "R0", description: "Three-layer consent ledger" },
  { key: "buyer_confirmations", enabled: true, releaseTag: "R1", description: "Buyer confirmation workflow" },
  { key: "stamp_verification", enabled: true, releaseTag: "R1", description: "Public stamp verification" },
  { key: "messaging_notifications", enabled: false, releaseTag: "R1", description: "WhatsApp/SMS/email notifications" },
  { key: "anonymized_benchmarks", enabled: false, releaseTag: "R2", description: "Layer-2 anonymized aggregate analytics" },
  { key: "credit_readiness", enabled: false, releaseTag: "R3", description: "Layer-3 credit readiness scoring" },
  { key: "bank_data_room", enabled: false, releaseTag: "R4", description: "Bank data room and financing origination" },
];

const SCHEMA_VERSIONS: { version: number; description: string }[] = [
  { version: 1, description: "Initial data spine (parties, invoices, lifecycle, consent, audit, platform, credit)" },
  { version: 2, description: "Persisted operator-editable error catalogue (ADV-03)" },
];

// Trusted internal work: seeding runs with tenant RLS bypassed (CON-01/SEC-02).
export async function seedPlatform(): Promise<void> {
  await runInBypassContext(async () => {
    for (const flag of FLAGS) {
      await getDb()
        .insert(featureFlagsTable)
        .values(flag)
        .onConflictDoNothing({ target: featureFlagsTable.key });
    }
    for (const v of SCHEMA_VERSIONS) {
      await getDb()
        .insert(schemaVersionsTable)
        .values(v)
        .onConflictDoNothing({ target: schemaVersionsTable.version });
    }
    await seedCatalogue();
  });
  logger.info(
    { flags: FLAGS.length, schemaVersions: SCHEMA_VERSIONS.length },
    "Platform seed complete",
  );
}
