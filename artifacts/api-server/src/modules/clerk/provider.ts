import type { ClerkGateway, ClerkProvider, CompletionRequest } from "./gateway";
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
    async complete(req: CompletionRequest): Promise<string> {
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
      return response.choices[0]?.message?.content ?? "";
    },
  };
}

export async function getClerkGateway(): Promise<ClerkGateway> {
  if (!cached) {
    cached = createGateway(await buildProvider());
  }
  return cached;
}
