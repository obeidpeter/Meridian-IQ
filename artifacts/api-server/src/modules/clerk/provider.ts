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

const CLERK_MODEL = process.env.CLERK_MODEL ?? "gpt-5.4";

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
// production extraction runs. Note the stored eval-run row's `model` column
// carries the gateway's default; the per-call ledger is the authority.
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

async function buildProvider(): Promise<ClerkProvider> {
  const { openai } = await import(
    "@workspace/integrations-openai-ai-server"
  );
  const tiers = parseModelTiers(process.env.CLERK_MODEL_TIERS);
  return {
    model: CLERK_MODEL,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const model = modelForPurpose(req.purpose, tiers, CLERK_MODEL);
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
    },
  };
}

export async function getClerkGateway(): Promise<ClerkGateway> {
  if (!cached) {
    cached = createGateway(await buildProvider());
  }
  return cached;
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
