import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  getDb,
  featureFlagsTable,
  usersTable,
  clerkInferenceCallsTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import {
  createGateway,
  CLERK_FLAG_KEY,
  sha256,
  type ClerkGateway,
  type ClerkProvider,
} from "./gateway.ts";
import { createExtractionCase } from "./cases.ts";
import { getClerkMetrics } from "./metrics.ts";

// Clerk v0.1 additions: voice-note intake (C1 "English voice transcription")
// and the operational-metrics aggregation (CLK-OBS-04). Same conventions as
// clerk.test.ts: fixed fixture users (the ledger is append-only), injected
// fake gateway/transcriber, kill switch forced on for the run.

const FAKE_MODEL = "fake-model-test";
const actorId = "cccc0006-0000-4000-8000-00000000cc06";

let flagWasEnabled: boolean | null = null;

function fakeGateway(respond: () => string | Promise<string>): ClerkGateway {
  const provider: ClerkProvider = {
    model: FAKE_MODEL,
    complete: async () => respond(),
  };
  return createGateway(provider);
}

// A minimal valid extraction the fake model returns.
const VALID_EXTRACTION = JSON.stringify({
  fields: [
    {
      field: "invoiceNumber",
      value: "INV-77",
      confidence: 0.95,
      sourceSnippet: "INV-77",
    },
  ],
  lines: [],
});

// Sixteen bytes of fake "audio" — the transcriber is injected, so content
// never matters; only the ledger discipline around it does.
const FAKE_AUDIO = Buffer.from("fake-audio-bytes").toString("base64");

before(async () => {
  const db = getDb();
  const [flag] = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, CLERK_FLAG_KEY))
    .limit(1);
  flagWasEnabled = flag ? flag.enabled : null;
  await db
    .insert(featureFlagsTable)
    .values({ key: CLERK_FLAG_KEY, enabled: true, description: "test" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: true },
    });
  await db
    .insert(usersTable)
    .values({ id: actorId, email: "clerk-v01-test@test.local" })
    .onConflictDoNothing();
});

after(async () => {
  if (flagWasEnabled !== null) {
    await getDb()
      .update(featureFlagsTable)
      .set({ enabled: flagWasEnabled })
      .where(eq(featureFlagsTable.key, CLERK_FLAG_KEY));
  }
});

test("voice intake transcribes, extracts, and keeps only the transcript", async () => {
  const gateway = fakeGateway(() => VALID_EXTRACTION);
  const kase = await createExtractionCase(
    {
      sourceType: "voice",
      name: "note.wav",
      audioBase64: FAKE_AUDIO,
    },
    actorId,
    gateway,
    async () => "I sold goods to Chukwuma Stores, invoice INV-77, today.",
  );

  assert.equal(kase.status, "extracted");
  assert.equal(kase.sourceType, "voice");
  // OPEN-8 minimisation: the transcript is the retained source; no audio.
  assert.equal(
    kase.sourceText,
    "I sold goods to Chukwuma Stores, invoice INV-77, today.",
  );
  assert.equal(kase.sourceImageB64, null);
  assert.ok(kase.extraction);
  assert.equal(
    kase.extraction!.fields.find((f) => f.field === "invoiceNumber")?.value,
    "INV-77",
  );

  // The transcription itself is ledgered like any other model call, keyed by
  // the hash of the audio payload — success recorded with transcript length.
  const audioHash = sha256(Buffer.from(FAKE_AUDIO, "base64").toString("base64"));
  const ledger = await getDb()
    .select()
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.inputRef, audioHash));
  const transcribe = ledger.filter((l) => l.purpose === "transcribe_voice");
  assert.ok(transcribe.length >= 1, "transcription must be ledgered");
  const last = transcribe.at(-1)!;
  assert.equal(last.outcome, "ok");
  assert.equal(last.schemaValid, true);
});

test("voice intake fails closed when transcription fails, with a ledger row", async () => {
  const gateway = fakeGateway(() => VALID_EXTRACTION);
  const failingAudio = Buffer.from("failing-audio-1").toString("base64");
  await assert.rejects(
    createExtractionCase(
      { sourceType: "voice", audioBase64: failingAudio },
      actorId,
      gateway,
      async () => {
        throw new Error("provider down");
      },
    ),
    (e: unknown) =>
      e instanceof DomainError &&
      e.code === "VOICE_UNREADABLE" &&
      e.status === 422,
  );
  const ledger = await getDb()
    .select()
    .from(clerkInferenceCallsTable)
    .where(
      eq(
        clerkInferenceCallsTable.inputRef,
        sha256(Buffer.from(failingAudio, "base64").toString("base64")),
      ),
    );
  const row = ledger.find((l) => l.purpose === "transcribe_voice");
  assert.ok(row, "failed transcription must still be ledgered");
  assert.equal(row!.outcome, "error");
});

test("empty transcripts are rejected, not extracted from", async () => {
  const gateway = fakeGateway(() => VALID_EXTRACTION);
  await assert.rejects(
    createExtractionCase(
      {
        sourceType: "voice",
        audioBase64: Buffer.from("silent-audio-xx").toString("base64"),
      },
      actorId,
      gateway,
      async () => "   ",
    ),
    (e: unknown) =>
      e instanceof DomainError && e.code === "VOICE_NO_SPEECH",
  );
});

test("voice source requires audioBase64", async () => {
  const gateway = fakeGateway(() => VALID_EXTRACTION);
  await assert.rejects(
    createExtractionCase({ sourceType: "voice" }, actorId, gateway, async () => "x"),
    (e: unknown) => e instanceof DomainError && e.code === "BAD_UPLOAD",
  );
});

test("metrics aggregate cases and the inference ledger", async () => {
  // Guarantee at least one extraction case and its ledger rows exist.
  const gateway = fakeGateway(() => VALID_EXTRACTION);
  await createExtractionCase(
    { sourceType: "text", text: "Invoice INV-88 to someone, NGN 100" },
    actorId,
    gateway,
  );

  const metrics = await getClerkMetrics(30);
  assert.equal(metrics.windowDays, 30);
  assert.ok(metrics.cases.total >= 1);
  assert.ok((metrics.cases.byKind["extraction"] ?? 0) >= 1);
  assert.ok(metrics.inference.total >= 1);
  assert.ok((metrics.inference.byOutcome["ok"] ?? 0) >= 1);
  // Rates are 0..1 and never NaN, even on sparse data.
  for (const r of [
    metrics.inference.invalidRate,
    metrics.inference.errorRate,
    metrics.ask.refusalRate,
  ]) {
    assert.ok(Number.isFinite(r) && r >= 0 && r <= 1);
  }
  // Cohorts include the fake model with at least one ok call.
  const cohort = metrics.inference.cohorts.find((c) => c.model === FAKE_MODEL);
  assert.ok(cohort);
  assert.ok(cohort!.okCount >= 1);
});
