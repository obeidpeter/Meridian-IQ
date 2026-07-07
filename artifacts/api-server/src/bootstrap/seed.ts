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
  billingTiersTable,
  firmSubscriptionsTable,
  onboardingProspectsTable,
  operatorCasesTable,
  revenueShareStatementsTable,
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
  // R2 — Channel Scale and Buyer Rails v1. Shipped dark (PL-02): an operator
  // flips each flag when its gate evidence lands (or per-firm via override).
  { key: "reconciliation", enabled: false, releaseTag: "R2", description: "Bank-statement ingestion and reconciliation v1 (SME-07, INT-05)" },
  { key: "b2c_reporting", enabled: false, releaseTag: "R2", description: "B2C 24-hour reporting module with compliance clocks (SME-08)" },
  { key: "buyer_rails", enabled: false, releaseTag: "R2", description: "Buyer Rails v1: supplier verification, payment flags, scoreboard (BR-01..BR-05)" },
  { key: "white_label", enabled: false, releaseTag: "R2", description: "White-label theming, subdomains, bulk client import, certification (CON-05)" },
  { key: "erp_connectors", enabled: false, releaseTag: "R2", description: "ERP connector contract and first two connectors (PL-03, INT-06)" },
  { key: "credit_readiness", enabled: false, releaseTag: "R3", description: "Layer-3 credit readiness scoring" },
  { key: "bank_data_room", enabled: false, releaseTag: "R4", description: "Bank data room and financing origination" },
];

const SCHEMA_VERSIONS: { version: number; description: string }[] = [
  { version: 1, description: "Initial data spine (parties, invoices, lifecycle, consent, audit, platform, credit)" },
  { version: 2, description: "Persisted operator-editable error catalogue (ADV-03)" },
  { version: 3, description: "R2 spine: statements/reconciliation, B2C batches, buyer rails columns, certification, connectors" },
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
    await seedConsoleDemo();
    await seedBuyerDemo();
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
  supplierPartyId?: string;
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
      supplierPartyId: input.supplierPartyId ?? DEMO.clientPartyId,
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

// --- Buyer Rails demo principals (BR-01..BR-05) ------------------------------
// Fixed identifiers so the buyer portal can inject stable x-mock-* headers.
// One buyer-side finance user per demo anchor buyer.
export const BUYERS = {
  zenithUserId: "b0000001-0000-4000-8000-0000000000d1",
  saharaUserId: "b0000002-0000-4000-8000-0000000000d2",
} as const;

async function seedBuyerDemo(): Promise<void> {
  await getDb()
    .insert(usersTable)
    .values([
      {
        id: BUYERS.zenithUserId,
        email: "finance@zenithretail.example",
        fullName: "Zenith Retail Finance",
      },
      {
        id: BUYERS.saharaUserId,
        email: "accounts@saharalogistics.example",
        fullName: "Sahara Logistics Accounts",
      },
    ])
    .onConflictDoNothing({ target: usersTable.id });

  // buyer_user memberships carry no firm; scope is the buyer Party. The
  // memberships unique index is NULLS NOT DISTINCT, so re-seeding conflicts
  // instead of duplicating.
  await getDb()
    .insert(membershipsTable)
    .values([
      {
        userId: BUYERS.zenithUserId,
        firmId: null,
        role: "buyer_user",
        clientPartyId: null,
        buyerPartyId: DEMO.buyerOneId,
      },
      {
        userId: BUYERS.saharaUserId,
        firmId: null,
        role: "buyer_user",
        clientPartyId: null,
        buyerPartyId: DEMO.buyerTwoId,
      },
    ])
    .onConflictDoNothing();
}

// --- Console / accountant tooling demo data (Task #4) -----------------------
// Fixed identifiers so the console frontend can inject stable headers and
// deep-links survive restarts.
export const CONSOLE = {
  adminUserId: "44444444-4444-4444-8444-4444444444a0",
  operatorUserId: "99999999-9999-4999-8999-999999999999",
  clients: {
    kano: "cb000002-0000-4000-8000-0000000000b2",
    pharma: "cb000003-0000-4000-8000-0000000000b3",
    build: "cb000004-0000-4000-8000-0000000000b4",
  },
  tiers: {
    essential: "17e00001-0000-4000-8000-000000000001",
    complianceDesk: "17e00002-0000-4000-8000-000000000002",
    professional: "17e00003-0000-4000-8000-000000000003",
    enterpriseLite: "17e00004-0000-4000-8000-000000000004",
  },
} as const;

function lastMonthPeriod(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

async function seedConsoleDemo(): Promise<void> {
  // Firm admin (drives the console) and an operator (works the queue).
  await getDb()
    .insert(usersTable)
    .values([
      {
        id: CONSOLE.adminUserId,
        email: "demo.admin@meridianiq.example",
        fullName: "Amaka Okonkwo",
      },
      {
        id: CONSOLE.operatorUserId,
        email: "ops@meridianiq.example",
        fullName: "Compliance Desk Operator",
      },
    ])
    .onConflictDoNothing({ target: usersTable.id });

  await getDb()
    .insert(membershipsTable)
    .values({
      userId: CONSOLE.adminUserId,
      firmId: DEMO.firmId,
      role: "firm_admin",
      clientPartyId: null,
    })
    .onConflictDoNothing();

  // Additional client businesses under the demo firm so the portfolio has a
  // multi-client book with a spread of penalty risk.
  await getDb()
    .insert(partiesTable)
    .values([
      {
        id: CONSOLE.clients.kano,
        type: "client_business",
        legalName: "Kano Textiles Ltd",
        tin: "50000000-0005",
        tinValidated: true,
        cacNumber: "RC2222222",
        city: "Kano",
        countryCode: "NG",
      },
      {
        id: CONSOLE.clients.pharma,
        type: "client_business",
        legalName: "Niger Delta Pharma Ltd",
        tin: "60000000-0006",
        tinValidated: true,
        cacNumber: "RC3333333",
        city: "Port Harcourt",
        countryCode: "NG",
      },
      {
        id: CONSOLE.clients.build,
        type: "client_business",
        legalName: "Lagos BuildRight Ltd",
        tin: "70000000-0007",
        tinValidated: true,
        cacNumber: "RC4444444",
        city: "Lagos",
        countryCode: "NG",
      },
    ])
    .onConflictDoNothing({ target: partiesTable.id });

  const engagements: { id: string; clientPartyId: string; title: string }[] = [
    {
      id: "e0000002-0000-4000-8000-0000000000e2",
      clientPartyId: CONSOLE.clients.kano,
      title: "Kano Textiles — compliance retainer",
    },
    {
      id: "e0000003-0000-4000-8000-0000000000e3",
      clientPartyId: CONSOLE.clients.pharma,
      title: "Niger Delta Pharma — managed desk",
    },
    {
      id: "e0000004-0000-4000-8000-0000000000e4",
      clientPartyId: CONSOLE.clients.build,
      title: "Lagos BuildRight — compliance retainer",
    },
  ];
  for (const e of engagements) {
    await getDb()
      .insert(engagementsTable)
      .values({
        id: e.id,
        firmId: DEMO.firmId,
        clientPartyId: e.clientPartyId,
        type: "retainer",
        status: "in_progress",
        title: e.title,
      })
      .onConflictDoNothing({ target: engagementsTable.id });
  }

  // Kano Textiles: an overdue unsubmitted invoice (high penalty risk) + stamped.
  await seedInvoice({
    id: "bbbb2001-0000-4000-8000-000000002001",
    supplierPartyId: CONSOLE.clients.kano,
    buyerPartyId: DEMO.buyerOneId,
    invoiceNumber: "KAN-2001",
    status: "draft",
    category: "b2b",
    issueDate: isoDate(-25),
    lines: [
      { description: "Ankara fabric (bulk rolls)", quantity: "60", unitPrice: "22000", vatRate: "0.075" },
    ],
  });
  await seedInvoice({
    id: "bbbb2002-0000-4000-8000-000000002002",
    supplierPartyId: CONSOLE.clients.kano,
    buyerPartyId: DEMO.buyerTwoId,
    invoiceNumber: "KAN-2002",
    status: "stamped",
    category: "b2b",
    issueDate: isoDate(-8),
    lines: [
      { description: "Cotton yarn (cartons)", quantity: "120", unitPrice: "9500", vatRate: "0.075" },
    ],
  });

  // Niger Delta Pharma: a failed invoice (needs operator attention) + submitted.
  await seedInvoice({
    id: "cccc3001-0000-4000-8000-000000003001",
    supplierPartyId: CONSOLE.clients.pharma,
    buyerPartyId: DEMO.buyerOneId,
    invoiceNumber: "NDP-3001",
    status: "failed",
    category: "b2b",
    issueDate: isoDate(-6),
    lines: [
      { description: "Antimalarial tablets (packs)", quantity: "500", unitPrice: "4200", vatRate: "0.075" },
    ],
  });
  await seedSubmissionAttempt({
    invoiceId: "cccc3001-0000-4000-8000-000000003001",
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: "demo-3001-1",
    status: "error",
    errorCode: "MBS_SCHEMA_INVALID",
  });
  await seedInvoice({
    id: "cccc3002-0000-4000-8000-000000003002",
    supplierPartyId: CONSOLE.clients.pharma,
    buyerPartyId: DEMO.buyerTwoId,
    invoiceNumber: "NDP-3002",
    status: "submitted",
    category: "b2b",
    issueDate: isoDate(-2),
    lines: [
      { description: "Cold-chain vaccines (vials)", quantity: "300", unitPrice: "8800", vatRate: "0.075" },
    ],
  });

  // Lagos BuildRight: fully compliant (all stamped) — low risk.
  await seedInvoice({
    id: "dddd4001-0000-4000-8000-000000004001",
    supplierPartyId: CONSOLE.clients.build,
    buyerPartyId: DEMO.buyerOneId,
    invoiceNumber: "LBR-4001",
    status: "stamped",
    category: "b2b",
    issueDate: isoDate(-12),
    lines: [
      { description: "Reinforcement steel (tonnes)", quantity: "15", unitPrice: "620000", vatRate: "0.075" },
    ],
  });
  await seedInvoice({
    id: "dddd4002-0000-4000-8000-000000004002",
    supplierPartyId: CONSOLE.clients.build,
    buyerPartyId: DEMO.buyerTwoId,
    invoiceNumber: "LBR-4002",
    status: "stamped",
    category: "b2b",
    issueDate: isoDate(-4),
    lines: [
      { description: "Ready-mix concrete (m3)", quantity: "80", unitPrice: "48000", vatRate: "0.075" },
    ],
  });

  // Four commercial tiers (PL-01). Fixed ids so the subscription can reference.
  await getDb()
    .insert(billingTiersTable)
    .values([
      {
        id: CONSOLE.tiers.essential,
        key: "essential",
        name: "Essential",
        description: "Self-serve compliance for a single accountant.",
        monthlyPrice: "15000",
        includedInvoices: 50,
        overagePrice: "120",
        revenueSharePct: "0.10",
        operatorManaged: false,
        active: true,
        sortOrder: 1,
      },
      {
        id: CONSOLE.tiers.complianceDesk,
        key: "compliance_desk",
        name: "Compliance Desk",
        description: "Operator-managed desk for busy multi-client firms.",
        monthlyPrice: "45000",
        includedInvoices: 200,
        overagePrice: "100",
        revenueSharePct: "0.15",
        operatorManaged: true,
        active: true,
        sortOrder: 2,
      },
      {
        id: CONSOLE.tiers.professional,
        key: "professional",
        name: "Professional",
        description: "High-volume firms with in-house compliance staff.",
        monthlyPrice: "120000",
        includedInvoices: 750,
        overagePrice: "80",
        revenueSharePct: "0.20",
        operatorManaged: false,
        active: true,
        sortOrder: 3,
      },
      {
        id: CONSOLE.tiers.enterpriseLite,
        key: "enterprise_lite",
        name: "Enterprise-lite",
        description: "Large practices approaching enterprise volumes.",
        monthlyPrice: "350000",
        includedInvoices: 3000,
        overagePrice: "55",
        revenueSharePct: "0.25",
        operatorManaged: false,
        active: true,
        sortOrder: 4,
      },
    ])
    .onConflictDoNothing({ target: billingTiersTable.key });

  // The demo firm subscribes to the operator-managed Compliance Desk tier.
  await getDb()
    .insert(firmSubscriptionsTable)
    .values({
      firmId: DEMO.firmId,
      tierId: CONSOLE.tiers.complianceDesk,
      status: "active",
    })
    .onConflictDoNothing({ target: firmSubscriptionsTable.firmId });

  // Onboarding pipeline (CON-02) + unearned-income basis (CON-03).
  await getDb()
    .insert(onboardingProspectsTable)
    .values([
      {
        id: "9a000001-0000-4000-8000-0000000000f1",
        firmId: DEMO.firmId,
        name: "Sokoto Grains Ltd",
        contactEmail: "finance@sokotograins.example",
        stage: "lead",
        estimatedMonthlyInvoices: 40,
        note: "Referred by Adaeze Foods.",
      },
      {
        id: "9a000002-0000-4000-8000-0000000000f2",
        firmId: DEMO.firmId,
        name: "Ibadan Motors Ltd",
        contactEmail: "accounts@ibadanmotors.example",
        stage: "contacted",
        estimatedMonthlyInvoices: 120,
      },
      {
        id: "9a000003-0000-4000-8000-0000000000f3",
        firmId: DEMO.firmId,
        name: "Enugu Cement Co",
        contactEmail: "cfo@enugucement.example",
        stage: "proposal",
        estimatedMonthlyInvoices: 300,
        note: "Proposal sent — awaiting sign-off.",
      },
      {
        id: "9a000004-0000-4000-8000-0000000000f4",
        firmId: DEMO.firmId,
        name: "Port Harcourt Oil Services",
        contactEmail: "ops@phoilservices.example",
        stage: "onboarding",
        estimatedMonthlyInvoices: 220,
      },
      {
        id: "9a000005-0000-4000-8000-0000000000f5",
        firmId: DEMO.firmId,
        name: "Abuja Interiors Ltd",
        stage: "lost",
        estimatedMonthlyInvoices: 0,
        note: "Chose an in-house solution.",
      },
    ])
    .onConflictDoNothing({ target: onboardingProspectsTable.id });

  // Cross-tenant operator work queue (CON-04) — cases carry an error code so the
  // console can surface the catalogue playbook and offer a one-click resolution.
  const now = Date.now();
  await getDb()
    .insert(operatorCasesTable)
    .values([
      {
        id: "0a000001-0000-4000-8000-0000000000c1",
        firmId: DEMO.firmId,
        clientPartyId: CONSOLE.clients.pharma,
        invoiceId: "cccc3001-0000-4000-8000-000000003001",
        title: "NDP-3001 rejected: schema invalid",
        errorCode: "MBS_SCHEMA_INVALID",
        priority: "high",
        status: "open",
        openedAt: new Date(now - 3 * 60 * 60 * 1000),
      },
      {
        id: "0a000002-0000-4000-8000-0000000000c2",
        firmId: DEMO.firmId,
        clientPartyId: DEMO.clientPartyId,
        invoiceId: "aaaa1004-0000-4000-8000-000000001004",
        title: "INV-1004 rejected: invalid TIN",
        errorCode: "MBS_INVALID_TIN",
        priority: "high",
        status: "in_progress",
        assignedOperatorId: CONSOLE.operatorUserId,
        openedAt: new Date(now - 5 * 60 * 60 * 1000),
        firstActionAt: new Date(now - 30 * 60 * 1000),
      },
      {
        id: "0a000003-0000-4000-8000-0000000000c3",
        firmId: DEMO.firmId,
        clientPartyId: CONSOLE.clients.kano,
        title: "KAN-2001 approaching submission deadline",
        errorCode: "RAIL_TIMEOUT",
        priority: "medium",
        status: "open",
        openedAt: new Date(now - 60 * 60 * 1000),
      },
      {
        id: "0a000004-0000-4000-8000-0000000000c4",
        firmId: DEMO.firmId,
        clientPartyId: CONSOLE.clients.build,
        title: "LBR-4001 stamp confirmation reconciled",
        errorCode: "RAIL_RATE_LIMITED",
        priority: "low",
        status: "resolved",
        assignedOperatorId: CONSOLE.operatorUserId,
        resolutionCode: "retried_after_backoff",
        resolutionNote: "Re-submitted after rate-limit window cleared.",
        openedAt: new Date(now - 26 * 60 * 60 * 1000),
        firstActionAt: new Date(now - 25 * 60 * 60 * 1000),
        resolvedAt: new Date(now - 25 * 60 * 60 * 1000 + 7 * 60 * 1000),
        handleSeconds: 420,
      },
    ])
    .onConflictDoNothing({ target: operatorCasesTable.id });

  // A prior-month revenue-share statement so CON-06 has history to export.
  const period = lastMonthPeriod();
  const billed = 240;
  const included = 200;
  const overage = billed - included;
  const subscription = 45000;
  const overageAmount = overage * 100;
  const billing = subscription + overageAmount;
  const pct = 0.15;
  await getDb()
    .insert(revenueShareStatementsTable)
    .values({
      firmId: DEMO.firmId,
      period,
      tierKey: "compliance_desk",
      billedInvoices: billed,
      includedInvoices: included,
      overageInvoices: overage,
      subscriptionAmount: subscription.toFixed(2),
      overageAmount: overageAmount.toFixed(2),
      billingAmount: billing.toFixed(2),
      revenueSharePct: pct.toString(),
      revenueShareAmount: (billing * pct).toFixed(2),
      breakdown: {
        tierName: "Compliance Desk",
        monthlyPrice: "45000",
        overagePrice: "100",
      },
    })
    .onConflictDoNothing();
}
