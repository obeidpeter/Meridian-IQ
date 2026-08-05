import { randomUUID } from "node:crypto";
import express from "express";
import {
  getDb,
  alertPreferencesTable,
  firmsTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import inboundRouter from "../../routes/inbound.ts";
import { errorHandler } from "../../middleware/error.ts";

// Shared scaffolding for the inbound rail tests (email, WhatsApp): both rails
// pin the same posture against the same route surface, so the express
// harness, the polling probe and the text-PDF fixture live here once (the
// clerk/test-support.ts precedent). Anything content-bearing is parameterized
// on the caller's run salt so each rail keeps its own distinct fixtures.

export const okExtraction = () => JSON.stringify({ fields: [], lines: [] });

// The one-page PDF scaffold both text-PDF builders below draw on (catalog,
// pages, font, stream wrapper, trailer — no xref table; pdfjs is lenient), so
// a parser-tightening fixture fix lands here ONCE.
function onePagePdf(mediaBox: string, streamBody: string): string {
  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length ${streamBody.length} >> stream
${streamBody}
endstream endobj
trailer << /Size 6 /Root 1 0 R >>
%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

// A one-page PDF whose content stream draws real text (the clerk-scan.test
// fixture), so extraction stays on the text path.
export function textPdf(tag: string, salt: string): string {
  return onePagePdf(
    "0 0 300 100",
    `BT /F1 14 Tf 20 50 Td (INVOICE ${tag} ${salt}) Tj ET`,
  );
}

// A one-page PDF drawing ARBITRARY text (the textPdf scaffold with the body
// text parameterized, so notice fixtures exist too). pdfjs only extracts
// glyphs actually laid out on the page, so the text is wrapped into short
// lines on a letter-sized page — a single long run would clip to the page
// width and truncate the extracted text.
export function pdfWithText(text: string): string {
  const lines = text.match(/.{1,40}/g) ?? [""];
  const body = lines
    .map((line, i) => `${i === 0 ? "20 770 Td" : "0 -14 Td"} (${line}) Tj`)
    .join(" ");
  return onePagePdf("0 0 612 792", `BT /F1 12 Tf ${body} ET`);
}

// A PDF attachment factory bound to one file's salt, so filenames and bytes
// stay per-run and per-rail unique.
export function makePdfAttachment(salt: string) {
  return (tag: string) => ({
    filename: `${tag}-${salt}.pdf`,
    contentType: "application/pdf",
    contentBase64: textPdf(tag, salt),
  });
}

// A CSV attachment factory (an unsupported type on the rails, for cap and
// skip fixtures), mirroring makePdfAttachment: filenames stay per-run and
// per-rail unique via the caller's salt; the bytes are the caller's own.
export function makeCsvAttachment(salt: string, contentBase64: string) {
  return (tag: string) => ({
    filename: `${tag}-${salt}.csv`,
    contentType: "text/csv",
    contentBase64,
  });
}

// Save/set/run/restore for one env var (deleting it when it was unset), so a
// knob-twiddling test can never leak state into its siblings.
export async function withEnv(
  name: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

// Per-run unique phone digits for the WhatsApp fixtures: the shared DB
// accumulates alert_preferences rows from every run, and a reused number
// would make a run's matches ambiguous. Computed ONCE at module load so
// every suite in one process shares the same run-unique suffix; the prefix
// partitions the fixtures.
export const runPhoneDigits = `${Date.now()}${process.pid}`.slice(-8);

// The prefix registry — the ONE place claimed prefixes live (the union type
// keeps claims greppable and an unclaimed prefix a type error):
//   70–75  whatsapp.test.ts
//   76     triage.test.ts
export function testPhone(prefix: 70 | 71 | 72 | 73 | 74 | 75 | 76 | 77): string {
  return `+234${prefix}${runPhoneDigits}`;
}

// One canonical inbound-client fixture write (the test-helpers/seeders.ts
// idiom: a seeder is a named spelling of one canonical write): firm +
// client_business party + user + the client_user membership binding them,
// plus an optional client-set alert_preferences row for WhatsApp routing.
// Rail-specific extras (staff memberships, ambiguous-number twins,
// party-only fixtures, ledger burns) stay inline in the test files.
export async function seedInboundClient(
  db: ReturnType<typeof getDb>,
  opts: {
    firmName: string;
    partyName: string;
    email: string;
    whatsapp?: { number: string; setByRole: string };
  },
): Promise<{ firmId: string; partyId: string; userId: string }> {
  const firmId = randomUUID();
  const partyId = randomUUID();
  const userId = randomUUID();
  await db.insert(firmsTable).values({ id: firmId, name: opts.firmName });
  await db.insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: opts.partyName,
  });
  await db.insert(usersTable).values({ id: userId, email: opts.email });
  await db.insert(membershipsTable).values({
    userId,
    firmId,
    role: "client_user",
    clientPartyId: partyId,
  });
  if (opts.whatsapp) {
    await db.insert(alertPreferencesTable).values({
      clientPartyId: partyId,
      whatsappTo: opts.whatsapp.number,
      contactSetByRole: opts.whatsapp.setByRole,
    });
  }
  return { firmId, partyId, userId };
}

export function inboundApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use((req, _res, next) => {
    req.log = {
      warn: () => {},
      error: () => {},
      info: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use("/api", inboundRouter);
  app.use(errorHandler);
  return app;
}

export async function eventually<T>(
  probe: () => Promise<T | null | undefined>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
