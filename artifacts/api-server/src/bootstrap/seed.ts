import { eq } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  featureFlagsTable,
  schemaVersionsTable,
  partiesTable,
  firmsTable,
  usersTable,
  membershipsTable,
  engagementsTable,
  invoicesTable,
  invoiceLinesTable,
  stampRecordsTable,
  submissionAttemptsTable,
  consentRecordsTable,
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
    await seedDemo();
  });
  logger.info(
    { flags: FLAGS.length, schemaVersions: SCHEMA_VERSIONS.length },
    "Platform seed complete",
  );
}

// Fixed identifiers for the demo SME tenant so the frontend can inject stable
// x-mock-* headers and deep-links stay valid across restarts.
export const DEMO = {
  firmId: "11111111-1111-4111-8111-111111111111",
  firmPartyId: "33333333-3333-4333-8333-333333333333",
  // The SME's own business Party — it is the supplier on every invoice and the
  // subject of the alert preferences / compliance calendar.
  clientPartyId: "22222222-2222-4222-8222-222222222222",
  userId: "44444444-4444-4444-8444-444444444444",
  engagementId: "77777777-7777-4777-8777-777777777777",
  buyerOneId: "55555555-5555-4555-8555-555555555555",
  buyerTwoId: "66666666-6666-4666-8666-666666666666",
} as const;

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

type SeedLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
};

async function seedInvoice(input: {
  id: string;
  buyerPartyId: string;
  invoiceNumber: string;
  status: "draft" | "validated" | "submitted" | "stamped" | "failed";
  category: "b2b" | "b2c";
  issueDate: string;
  lines: SeedLine[];
}): Promise<void> {
  let subtotal = 0;
  let vatTotal = 0;
  const lines = input.lines.map((line, index) => {
    const ext = Number(line.quantity) * Number(line.unitPrice);
    const vat = ext * Number(line.vatRate);
    subtotal += ext;
    vatTotal += vat;
    return {
      invoiceId: input.id,
      lineNo: index + 1,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      vatRate: line.vatRate,
      lineExtension: ext.toFixed(2),
      vatAmount: vat.toFixed(2),
    };
  });

  const insertedInvoice = await getDb()
    .insert(invoicesTable)
    .values({
      id: input.id,
      firmId: DEMO.firmId,
      supplierPartyId: DEMO.clientPartyId,
      buyerPartyId: input.buyerPartyId,
      invoiceNumber: input.invoiceNumber,
      category: input.category,
      issueDate: input.issueDate,
      status: input.status,
      subtotal: subtotal.toFixed(2),
      vatTotal: vatTotal.toFixed(2),
      grandTotal: (subtotal + vatTotal).toFixed(2),
    })
    .onConflictDoNothing({ target: invoicesTable.id })
    .returning({ id: invoicesTable.id });

  // Only seed lines when the invoice row was newly created. Invoice lines have
  // no natural unique key and become immutable after submission, so inserting
  // them on every seed run would append duplicates that cannot be cleaned up.
  if (insertedInvoice.length === 0) return;
  for (const line of lines) {
    await getDb().insert(invoiceLinesTable).values(line);
  }
}

// submission_attempts is append-only (immutable rows) with no natural unique
// key, so onConflictDoNothing cannot dedupe. Insert the demo attempt only when
// one does not already exist for its idempotency key, keeping reseeds clean.
async function seedSubmissionAttempt(input: {
  invoiceId: string;
  rail: "rail_primary";
  attemptNo: number;
  idempotencyKey: string;
  status: "pending" | "accepted" | "rejected" | "error";
  errorCode?: string;
}): Promise<void> {
  const existing = await getDb()
    .select({ id: submissionAttemptsTable.id })
    .from(submissionAttemptsTable)
    .where(eq(submissionAttemptsTable.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing.length > 0) return;
  await getDb().insert(submissionAttemptsTable).values({
    invoiceId: input.invoiceId,
    rail: input.rail,
    attemptNo: input.attemptNo,
    idempotencyKey: input.idempotencyKey,
    status: input.status,
    errorCode: input.errorCode ?? null,
  });
}

// A ready-to-explore SME tenant: the firm, the SME's own business party, an
// engagement (so firm_staff passes assertPartyAccess), a firm_staff user,
// layer-1 consent (so submit works), buyers, and invoices in every lifecycle
// state the dashboard and vault surface.
async function seedDemo(): Promise<void> {
  await getDb()
    .insert(partiesTable)
    .values([
      {
        id: DEMO.firmPartyId,
        type: "firm",
        legalName: "Meridian Advisory Partners",
        tin: "10000000-0001",
        tinValidated: true,
        countryCode: "NG",
      },
      {
        id: DEMO.clientPartyId,
        type: "client_business",
        legalName: "Adaeze Foods Ltd",
        tin: "20000000-0002",
        tinValidated: true,
        cacNumber: "RC1234567",
        street: "14 Adeola Odeku Street",
        city: "Lagos",
        countryCode: "NG",
      },
      {
        id: DEMO.buyerOneId,
        type: "buyer",
        legalName: "Zenith Retail Group",
        tin: "30000000-0003",
        tinValidated: true,
        street: "2 Broad Street",
        city: "Lagos",
        countryCode: "NG",
      },
      {
        id: DEMO.buyerTwoId,
        type: "buyer",
        legalName: "Sahara Logistics Ltd",
        tin: "40000000-0004",
        tinValidated: true,
        street: "9 Aminu Kano Crescent",
        city: "Abuja",
        countryCode: "NG",
      },
    ])
    .onConflictDoNothing({ target: partiesTable.id });

  await getDb()
    .insert(firmsTable)
    .values({
      id: DEMO.firmId,
      name: "Meridian Advisory Partners",
      subdomain: "meridian-demo",
      partyId: DEMO.firmPartyId,
    })
    .onConflictDoNothing({ target: firmsTable.id });

  await getDb()
    .insert(usersTable)
    .values({
      id: DEMO.userId,
      email: "demo.staff@meridianiq.example",
      fullName: "Demo Staff",
    })
    .onConflictDoNothing({ target: usersTable.id });

  await getDb()
    .insert(membershipsTable)
    .values({
      userId: DEMO.userId,
      firmId: DEMO.firmId,
      role: "firm_staff",
      clientPartyId: DEMO.clientPartyId,
    })
    .onConflictDoNothing();

  await getDb()
    .insert(engagementsTable)
    .values({
      id: DEMO.engagementId,
      firmId: DEMO.firmId,
      clientPartyId: DEMO.clientPartyId,
      type: "retainer",
      status: "in_progress",
      title: "Adaeze Foods — compliance retainer",
    })
    .onConflictDoNothing({ target: engagementsTable.id });

  // Layer-1 (compliance) consent so submission and vault storage are permitted.
  const [existingConsent] = await getDb()
    .select({ id: consentRecordsTable.id })
    .from(consentRecordsTable)
    .where(eq(consentRecordsTable.partyId, DEMO.clientPartyId))
    .limit(1);
  if (!existingConsent) {
    await getDb().insert(consentRecordsTable).values({
      partyId: DEMO.clientPartyId,
      layer: 1,
      action: "grant",
      scope: "compliance_submission",
      basis: "contract",
      channel: "seed",
    });
  }

  await seedInvoice({
    id: "aaaa1001-0000-4000-8000-000000001001",
    buyerPartyId: DEMO.buyerOneId,
    invoiceNumber: "INV-1001",
    status: "draft",
    category: "b2b",
    issueDate: isoDate(-30),
    lines: [
      { description: "Palm oil (25L drums)", quantity: "10", unitPrice: "18000", vatRate: "0.075" },
    ],
  });
  await seedInvoice({
    id: "aaaa1002-0000-4000-8000-000000001002",
    buyerPartyId: DEMO.buyerOneId,
    invoiceNumber: "INV-1002",
    status: "validated",
    category: "b2b",
    issueDate: isoDate(-2),
    lines: [
      { description: "Rice (50kg bags)", quantity: "40", unitPrice: "62000", vatRate: "0.075" },
      { description: "Delivery handling", quantity: "1", unitPrice: "15000", vatRate: "0.075" },
    ],
  });
  await seedInvoice({
    id: "aaaa1003-0000-4000-8000-000000001003",
    buyerPartyId: DEMO.buyerTwoId,
    invoiceNumber: "INV-1003",
    status: "stamped",
    category: "b2b",
    issueDate: isoDate(-10),
    lines: [
      { description: "Cold-chain freight (Lagos–Abuja)", quantity: "3", unitPrice: "240000", vatRate: "0.075" },
    ],
  });
  await getDb()
    .insert(stampRecordsTable)
    .values({
      invoiceId: "aaaa1003-0000-4000-8000-000000001003",
      irn: "IRN-DEMO-1003",
      csid: "CSID-DEMO-1003",
      qrPayload: "https://verify.meridianiq.example/IRN-DEMO-1003",
      signedArtifactRef: "artifact://demo/INV-1003.xml",
      rail: "rail_primary",
    })
    .onConflictDoNothing({ target: stampRecordsTable.invoiceId });
  await seedSubmissionAttempt({
    invoiceId: "aaaa1003-0000-4000-8000-000000001003",
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: "demo-1003-1",
    status: "accepted",
  });

  await seedInvoice({
    id: "aaaa1004-0000-4000-8000-000000001004",
    buyerPartyId: DEMO.buyerOneId,
    invoiceNumber: "INV-1004",
    status: "failed",
    category: "b2b",
    issueDate: isoDate(-5),
    lines: [
      { description: "Packaging supplies", quantity: "100", unitPrice: "3500", vatRate: "0.075" },
    ],
  });
  await seedSubmissionAttempt({
    invoiceId: "aaaa1004-0000-4000-8000-000000001004",
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: "demo-1004-1",
    status: "error",
    errorCode: "MBS_INVALID_TIN",
  });

  await seedInvoice({
    id: "aaaa1005-0000-4000-8000-000000001005",
    buyerPartyId: DEMO.buyerTwoId,
    invoiceNumber: "INV-1005",
    status: "submitted",
    category: "b2c",
    issueDate: isoDate(-1),
    lines: [
      { description: "Retail groceries (consolidated)", quantity: "1", unitPrice: "480000", vatRate: "0.075" },
    ],
  });
}
