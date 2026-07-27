import express from "express";
import inboundRouter from "../../routes/inbound.ts";
import { errorHandler } from "../../middleware/error.ts";

// Shared scaffolding for the inbound rail tests (email, WhatsApp): both rails
// pin the same posture against the same route surface, so the express
// harness, the polling probe and the text-PDF fixture live here once (the
// clerk/test-support.ts precedent). Anything content-bearing is parameterized
// on the caller's run salt so each rail keeps its own distinct fixtures.

export const okExtraction = () => JSON.stringify({ fields: [], lines: [] });

// A one-page PDF whose content stream draws real text (the clerk-scan.test
// fixture), so extraction stays on the text path.
export function textPdf(tag: string, salt: string): string {
  const streamBody = `BT /F1 14 Tf 20 50 Td (INVOICE ${tag} ${salt}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length ${streamBody.length} >> stream
${streamBody}
endstream endobj
trailer << /Size 6 /Root 1 0 R >>
%%EOF`;
  return Buffer.from(pdf).toString("base64");
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
