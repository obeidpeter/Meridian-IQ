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

export const CLERK_MODEL = "gpt-5.4";

let cached: ClerkGateway | null = null;

async function buildProvider(): Promise<ClerkProvider> {
  const { openai } = await import(
    "@workspace/integrations-openai-ai-server"
  );
  return {
    model: CLERK_MODEL,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const response = await openai.chat.completions.create({
        model: CLERK_MODEL,
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
