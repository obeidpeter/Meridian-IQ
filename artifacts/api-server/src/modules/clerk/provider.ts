import type {
  ClerkGateway,
  ClerkProvider,
  CompletionRequest,
  CompletionResult,
} from "./gateway";
import { createGateway } from "./gateway";

// Production provider: OpenAI via the Replit AI integrations proxy. Kept in
// its own module (and loaded lazily) so importing the gateway in tests never
// requires the AI integration env vars.

// Exported for the tier report, which shows which model serves each purpose.
export const CLERK_MODEL = process.env.CLERK_MODEL ?? "gpt-5.4";

// Per-purpose model tiers (round-7 idea #1), OPT-IN via env — unset keeps
// today's single-model behaviour. Segmentation, triage and intent
// classification don't need the extraction-grade model; the unit-economics
// page (per-purpose spend) is the evidence for which tiers pay off, and the
// ledger records the model that ACTUALLY served each call, so cohorts and
// cost stay honest under tiering.
//
//   CLERK_MODEL_TIERS="segment_batch=gpt-5.4-mini,classify_intent=gpt-5.4-mini"
//
// Eval purposes (eval_extract, eval_canary) deliberately follow the
// extract_invoice tier unless explicitly overridden: evals must measure what
// production extraction runs. Caveat on provenance copies: a few stored rows
// snapshot `gateway.model` — the DEFAULT model — not the per-call route
// (eval-run rows, the extraction blob's `model`, triage proposals, NL draft
// results). Under tiering those labels can be stale; the inference ledger
// records the model that actually served each call and is the authority.
export function parseModelTiers(
  raw: string | undefined,
): Map<string, string> {
  const tiers = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const [purpose, model] = entry.split("=").map((s) => s.trim());
    if (purpose && model) tiers.set(purpose, model);
  }
  return tiers;
}

export function modelForPurpose(
  purpose: string | undefined,
  tiers: Map<string, string>,
  base: string,
): string {
  if (!purpose) return base;
  const direct = tiers.get(purpose);
  if (direct) return direct;
  if (purpose === "eval_extract" || purpose === "eval_canary") {
    return tiers.get("extract_invoice") ?? base;
  }
  return base;
}

let cached: ClerkGateway | null = null;

// Lazy client load, shared by the production gateway and the model-canary
// gateway: importing the integration only when a call is actually made keeps
// the AI env vars out of every test that injects a fake gateway.
async function loadOpenAI() {
  const { openai } = await import(
    "@workspace/integrations-openai-ai-server"
  );
  return openai;
}
type OpenAIClient = Awaited<ReturnType<typeof loadOpenAI>>;

// The one place a completion request actually leaves the platform. Both the
// tier-routing production provider and the fixed-model canary provider call
// this with the model they resolved.
async function completeWith(
  openai: OpenAIClient,
  model: string,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: req.system },
      // Untrusted document/question content travels ONLY in the user
      // message; the system prompt is fixed and versioned.
      { role: "user", content: req.user as never },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: req.schemaName,
        strict: true,
        schema: req.jsonSchema,
      },
    },
    max_completion_tokens: 8192,
  });
  return {
    content: response.choices[0]?.message?.content ?? "",
    promptTokens: response.usage?.prompt_tokens ?? null,
    completionTokens: response.usage?.completion_tokens ?? null,
    model,
  };
}

async function buildProvider(): Promise<ClerkProvider> {
  const openai = await loadOpenAI();
  const tiers = parseModelTiers(process.env.CLERK_MODEL_TIERS);
  return {
    model: CLERK_MODEL,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const model = modelForPurpose(req.purpose, tiers, CLERK_MODEL);
      try {
        return await completeWith(openai, model, req);
      } catch (err) {
        // Attach the routed model to the failure so the gateway's ERROR
        // ledger rows cohort against the model that was actually called —
        // a broken tier must show up under ITS model, not the default.
        if (err && typeof err === "object") {
          (err as { clerkModel?: string }).clerkModel = model;
        }
        throw err;
      }
    },
  };
}

export async function getClerkGateway(): Promise<ClerkGateway> {
  if (!cached) {
    cached = createGateway(await buildProvider());
  }
  return cached;
}

// Best-effort variant for the digest-posture surfaces (explainer, chaser,
// cover notes, narrative, reply drafts, reconcile assist): those modules all
// accept `ClerkGateway | null` and answer with their deterministic template
// when no model is available, so a provider that cannot even be CONSTRUCTED
// (missing AI-integration env) must yield null — never a 500 — for them.
// Fail-closed surfaces (capture, batch, ask, evals) keep calling
// getClerkGateway() directly so a broken provider surfaces as an error.
export async function gatewayOrNull(): Promise<ClerkGateway | null> {
  try {
    return await getClerkGateway();
  } catch {
    return null;
  }
}

// Model canary (model-canary.ts): a gateway whose provider ALWAYS calls the
// given model id, bypassing CLERK_MODEL_TIERS routing — the candidate side of
// a model canary must run the exact model under evaluation whatever tiering
// is in force. Wrapped in the ordinary gateway so the kill switch, ledger and
// schema validation apply to every candidate call; the ledger's model column
// carries the candidate id, so canary spend cohorts by served model. No
// caching: canaries are rare operator actions, each naming its own model.
export async function buildGatewayForModel(
  model: string,
): Promise<ClerkGateway> {
  const openai = await loadOpenAI();
  return createGateway({
    model,
    complete: (req: CompletionRequest) => completeWith(openai, model, req),
  });
}

// Voice transcription (C1: English voice notes). Kept beside the completion
// provider so tests can inject a fake transcriber the same way they inject a
// fake gateway. Format is sniffed from the bytes; mp4/ogg are converted where
// the runtime supports it, everything else transcribes directly.
export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

export type VoiceTranscriber = (audio: Buffer) => Promise<string>;

export async function transcribeVoiceProd(audio: Buffer): Promise<string> {
  const { speechToText, detectAudioFormat, ensureCompatibleFormat } =
    await import("@workspace/integrations-openai-ai-server/audio");
  const detected = detectAudioFormat(audio);
  if (detected === "wav" || detected === "mp3" || detected === "webm") {
    return speechToText(audio, detected);
  }
  // mp4/ogg (or unknown) go through conversion; failures surface as a typed
  // error to the caller, which records the ledger row and fails the intake.
  const compatible = await ensureCompatibleFormat(audio);
  return speechToText(compatible.buffer, compatible.format);
}
