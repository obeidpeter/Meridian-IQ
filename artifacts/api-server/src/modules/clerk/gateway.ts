import { createHash } from "node:crypto";
import { db, clerkInferenceCallsTable } from "@workspace/db";
import type { z } from "zod/v4";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";
import { firmClerkUsage } from "./budget";

// Inference gateway (Task #40). EVERY model call flows through here:
//  - the clerk_ai kill switch is checked before any call leaves the platform;
//  - the per-firm token budget is enforced here as a BACKSTOP for every
//    firm-attributed call (routes still pre-check for a clean 429; this
//    guarantees no call site can forget the cap);
//  - every call is recorded in the append-only clerk_inference_calls ledger
//    (model, prompt version, input hash, typed output, outcome);
//  - output is parsed and schema-validated; anything invalid is DISCARDED and
//    reported as a typed failure — never surfaced to a user (fail closed).
//
// Ledger writes deliberately use the ROOT db client (raw pool), never the
// ambient request transaction: tokens spent at the provider are spent whether
// or not the surrounding request later rolls back (the 4xx rollback rule
// would otherwise erase the spend and break "the ledger keeps the true
// spend"). This requires any caseId passed to infer() to reference an ALREADY
// COMMITTED case row (the capture and ask paths commit the case before
// inferring; retry and eval reference existing cases).
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

// Providers may return a bare string (tests, simple providers) or the string
// plus token usage where the API reports it (CLK-NFR-04 cost-to-serve).
export interface CompletionResult {
  content: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

export interface ClerkProvider {
  model: string;
  complete(req: CompletionRequest): Promise<string | CompletionResult>;
}

export type ClerkPurpose =
  | "extract_invoice"
  | "classify_intent"
  | "transcribe_voice"
  // Per-client monthly statement (idea #5): phrases SQL-computed facts about
  // one client's closed month; template fallback, digest posture.
  | "client_statement"
  // Customer-list import drafting (exhaust idea #4): proposes a column
  // mapping for an arbitrary customer CSV; header-verified, parser-proven.
  | "draft_client_import"
  // Drafted escalation replies (exhaust idea #5): phrases catalogue fix +
  // attempt history into a reply the operator edits and sends.
  | "draft_reply"
  // VAT filing cover note (round-4 idea #6): phrases the deterministic VAT
  // pack's computed facts; template fallback, nothing stored.
  | "draft_vat_note"
  // Adversarial eval growth (idea #9): generates an injection VARIANT of a
  // static eval fixture; the app validates the result before storing it and
  // resistance is scored by the ordinary eval machinery.
  | "adversarial_generate"
  // §13.1 evaluation traffic: same prompt and schema as extract_invoice, but
  // its own purpose so metrics cohorts separate eval runs from production.
  | "eval_extract"
  // Prompt canary (prompt-canary.ts): candidate-vs-incumbent corpus passes;
  // its own purpose so canary spend never blends into the eval cohort.
  | "eval_canary"
  // Scanned-bundle segmentation (batch-async): one vision call proposing
  // page ranges; the app validates coverage before anything else runs.
  | "segment_scan"
  // Catalogue-grounded failure explainer (expansion C): rephrases an error
  // catalogue entry in plain language; never invents remediation steps.
  | "explain_failure"
  // Batch intake (power S): splits one uploaded document into per-invoice
  // text segments; each segment then goes through normal extraction.
  | "segment_batch"
  // Weekly firm digest (power D): phrases platform-computed compliance facts;
  // the numbers themselves are never model output.
  | "digest"
  // Claims drafting assistant (power C5): turns a statutory excerpt into a
  // DRAFT claim-register entry — maker-checker review still applies in full.
  | "draft_claim"
  // Catalogue drafting assistant: proposes an error-catalogue entry from
  // observed rail rejections; the operator reviews and saves it manually.
  | "draft_catalogue"
  // Escalation triage (desk/triage.ts): closed-enum routing proposal for the
  // operator queue; the operator accepts or overrides, never auto-applied.
  | "triage_escalation"
  // Reconciliation match assist (reconcile-assist.ts): phrases the matcher's
  // recorded per-feature evidence for one statement line; template fallback.
  | "explain_match"
  // Natural-language invoice drafting (draft-invoice.ts): one sentence into a
  // prefilled draft form the client reviews and saves through createDraft.
  | "draft_invoice"
  // Statement-format bootstrap (draft-format.ts): proposes a column mapping
  // from a sample export; the deterministic parser validates before any save.
  | "draft_format"
  // Advisory narrative drafting (advisory/narrative.ts): phrases the
  // platform-computed assessment/VAT-risk facts; template fallback, never
  // stored — the firm partner edits and owns the letter.
  | "draft_narrative";

export interface InferParams<T> {
  purpose: ClerkPurpose;
  caseId?: string | null;
  // The firm the call is made on behalf of (client capture / firm Ask Clerk).
  // Stamped into the ledger so the per-firm monthly budget can be summed and
  // so a firm principal can read its own usage under the 0009 RLS policy.
  firmId?: string | null;
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
  firmId?: string | null;
  purpose: ClerkPurpose;
  model: string;
  promptVersion: string;
  inputForHash: string;
  outcome: "ok" | "error";
  outputChars?: number;
  errorText?: string;
  latencyMs: number;
}): Promise<void> {
  await db.insert(clerkInferenceCallsTable).values({
    caseId: input.caseId ?? null,
    firmId: input.firmId ?? null,
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

      // Budget backstop for firm-attributed calls. A typed failure, not a
      // throw: every caller already has a fail-closed path for a model that
      // did not run (capture marks the case failed, digest/explain fall back
      // to template text), and no ledger row is written — no call left the
      // platform, no tokens were spent.
      if (params.firmId) {
        const usage = await firmClerkUsage(params.firmId);
        if (usage.usedTokens >= usage.budgetTokens) {
          return {
            ok: false,
            outcome: "error",
            message:
              "The firm's monthly Clerk token allowance is exhausted; the call was not made.",
          };
        }
      }

      const startedAt = Date.now();
      const base = {
        caseId: params.caseId ?? null,
        firmId: params.firmId ?? null,
        purpose: params.purpose,
        model: provider.model,
        promptVersion: params.promptVersion,
        inputRef: sha256(params.inputForHash),
      };
      // Append one ledger row: the call's identity (base) plus the outcome
      // fields, which stay explicit at each call site below.
      const ledger = (
        row: Omit<
          typeof clerkInferenceCallsTable.$inferInsert,
          keyof typeof base
        >,
      ) => db.insert(clerkInferenceCallsTable).values({ ...base, ...row });

      let raw: string;
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      try {
        const completed = await provider.complete({
          system: params.system,
          user: params.user,
          schemaName: params.schemaName,
          jsonSchema: params.jsonSchema,
        });
        if (typeof completed === "string") {
          raw = completed;
        } else {
          raw = completed.content;
          promptTokens = completed.promptTokens ?? null;
          completionTokens = completed.completionTokens ?? null;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await ledger({
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
        await ledger({
          outputJson: { raw: raw.slice(0, 8000) },
          schemaValid: false,
          outcome: "invalid_discarded",
          errorText: "Output was not valid JSON",
          latencyMs: Date.now() - startedAt,
          promptTokens,
          completionTokens,
        });
        return {
          ok: false,
          outcome: "invalid_discarded",
          message: "Model output was not valid JSON and was discarded",
        };
      }

      const validated = params.validator.safeParse(parsed);
      if (!validated.success) {
        await ledger({
          outputJson: parsed,
          schemaValid: false,
          outcome: "invalid_discarded",
          errorText: validated.error.message.slice(0, 2000),
          latencyMs: Date.now() - startedAt,
          promptTokens,
          completionTokens,
        });
        return {
          ok: false,
          outcome: "invalid_discarded",
          message: "Model output failed schema validation and was discarded",
        };
      }

      await ledger({
        outputJson: parsed,
        schemaValid: true,
        outcome: "ok",
        latencyMs: Date.now() - startedAt,
        promptTokens,
        completionTokens,
      });
      return { ok: true, data: validated.data };
    },
  };
}
