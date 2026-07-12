import { createHash } from "node:crypto";
import { getDb, clerkInferenceCallsTable } from "@workspace/db";
import type { z } from "zod/v4";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";

// Inference gateway (Task #40). EVERY model call flows through here:
//  - the clerk_ai kill switch is checked before any call leaves the platform;
//  - every call is recorded in the append-only clerk_inference_calls ledger
//    (model, prompt version, input hash, typed output, outcome);
//  - output is parsed and schema-validated; anything invalid is DISCARDED and
//    reported as a typed failure — never surfaced to a user (fail closed).
//
// The provider is injected so fail-closed behaviour is testable without live
// model calls; the production provider lives in provider.ts.

export const CLERK_FLAG_KEY = "clerk_ai";

// User-message content: plain text, or OpenAI-style content parts (for vision).
export type UserContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export interface CompletionRequest {
  system: string;
  user: UserContent;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
}

export interface ClerkProvider {
  model: string;
  complete(req: CompletionRequest): Promise<string>;
}

export type ClerkPurpose =
  | "extract_invoice"
  | "classify_intent"
  | "transcribe_voice";

export interface InferParams<T> {
  purpose: ClerkPurpose;
  caseId?: string | null;
  promptVersion: string;
  system: string;
  user: UserContent;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  validator: z.ZodType<T>;
  // The exact untrusted input (document text / base64 / question); only its
  // sha256 goes into the ledger.
  inputForHash: string;
}

export type InferResult<T> =
  | { ok: true; data: T }
  | { ok: false; outcome: "invalid_discarded" | "error"; message: string };

export interface ClerkGateway {
  model: string;
  infer<T>(params: InferParams<T>): Promise<InferResult<T>>;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Ledger a model call that doesn't go through the JSON-schema completion path
// (audio transcription). Same discipline as infer(): every call that leaves
// the platform lands in the append-only ledger, success or failure. The
// transcript itself is NOT stored here — it lives on the case row; the ledger
// records provenance (model, input hash, outcome, latency) plus a length so
// drift in transcript size is observable without retaining content twice.
export async function recordExternalCall(input: {
  caseId?: string | null;
  purpose: ClerkPurpose;
  model: string;
  promptVersion: string;
  inputForHash: string;
  outcome: "ok" | "error";
  outputChars?: number;
  errorText?: string;
  latencyMs: number;
}): Promise<void> {
  await getDb().insert(clerkInferenceCallsTable).values({
    caseId: input.caseId ?? null,
    purpose: input.purpose,
    model: input.model,
    promptVersion: input.promptVersion,
    inputRef: sha256(input.inputForHash),
    outputJson:
      input.outcome === "ok" ? { chars: input.outputChars ?? 0 } : null,
    schemaValid: input.outcome === "ok",
    outcome: input.outcome,
    errorText: input.errorText?.slice(0, 2000) ?? null,
    latencyMs: input.latencyMs,
  });
}

// Throws CLERK_DISABLED (503) when the kill switch is off. Routes call this
// before doing any Clerk work; the gateway also enforces it before each call.
export async function assertClerkEnabled(): Promise<void> {
  if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) {
    throw new DomainError(
      "CLERK_DISABLED",
      "Clerk AI is currently disabled by the platform kill switch. Manual workflows are unaffected.",
      503,
    );
  }
}

export function createGateway(provider: ClerkProvider): ClerkGateway {
  return {
    model: provider.model,
    async infer<T>(params: InferParams<T>): Promise<InferResult<T>> {
      await assertClerkEnabled();

      const startedAt = Date.now();
      const base = {
        caseId: params.caseId ?? null,
        purpose: params.purpose,
        model: provider.model,
        promptVersion: params.promptVersion,
        inputRef: sha256(params.inputForHash),
      };

      let raw: string;
      try {
        raw = await provider.complete({
          system: params.system,
          user: params.user,
          schemaName: params.schemaName,
          jsonSchema: params.jsonSchema,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await getDb().insert(clerkInferenceCallsTable).values({
          ...base,
          outputJson: null,
          schemaValid: false,
          outcome: "error",
          errorText: message.slice(0, 2000),
          latencyMs: Date.now() - startedAt,
        });
        return { ok: false, outcome: "error", message: "Model call failed" };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await getDb().insert(clerkInferenceCallsTable).values({
          ...base,
          outputJson: { raw: raw.slice(0, 8000) },
          schemaValid: false,
          outcome: "invalid_discarded",
          errorText: "Output was not valid JSON",
          latencyMs: Date.now() - startedAt,
        });
        return {
          ok: false,
          outcome: "invalid_discarded",
          message: "Model output was not valid JSON and was discarded",
        };
      }

      const validated = params.validator.safeParse(parsed);
      if (!validated.success) {
        await getDb().insert(clerkInferenceCallsTable).values({
          ...base,
          outputJson: parsed,
          schemaValid: false,
          outcome: "invalid_discarded",
          errorText: validated.error.message.slice(0, 2000),
          latencyMs: Date.now() - startedAt,
        });
        return {
          ok: false,
          outcome: "invalid_discarded",
          message: "Model output failed schema validation and was discarded",
        };
      }

      await getDb().insert(clerkInferenceCallsTable).values({
        ...base,
        outputJson: parsed,
        schemaValid: true,
        outcome: "ok",
        latencyMs: Date.now() - startedAt,
      });
      return { ok: true, data: validated.data };
    },
  };
}
