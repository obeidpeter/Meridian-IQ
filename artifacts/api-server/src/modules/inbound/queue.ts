import { createHash } from "node:crypto";
import { getDb, outboxTable, runInBypassContext } from "@workspace/db";
import { registerHandler, type HandlerOutcome } from "../pipeline/pipeline";
import { processInboundEmail, type InboundEmailInput } from "./email";
import { processInboundWhatsApp, type InboundWhatsAppInput } from "./whatsapp";

type InboundKind = "email" | "whatsapp";

function messageHash(kind: InboundKind, payload: object): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(JSON.stringify(payload))
    .digest("hex");
}

async function enqueue(
  kind: InboundKind,
  payload: Record<string, unknown>,
): Promise<void> {
  await runInBypassContext(async () => {
    await getDb()
      .insert(outboxTable)
      .values({
        aggregateType: "inbound_message",
        aggregateId: messageHash(kind, payload),
        type: `inbound.${kind}`,
        payload,
      })
      .onConflictDoNothing();
  });
}

export async function enqueueInboundEmail(
  input: InboundEmailInput,
): Promise<void> {
  await enqueue("email", input as unknown as Record<string, unknown>);
}

export async function enqueueInboundWhatsApp(
  input: InboundWhatsAppInput,
): Promise<void> {
  await enqueue("whatsapp", input as unknown as Record<string, unknown>);
}

async function handleEmail(payload: Record<string, unknown>): Promise<void> {
  await processInboundEmail(payload as unknown as InboundEmailInput);
}

async function handleWhatsApp(payload: Record<string, unknown>): Promise<void> {
  await processInboundWhatsApp(payload as unknown as InboundWhatsAppInput);
}

function handler(
  process: (payload: Record<string, unknown>) => Promise<void>,
): (event: { payload: unknown }) => Promise<HandlerOutcome> {
  return async (event) => {
    await process(event.payload as Record<string, unknown>);
    return { kind: "done" };
  };
}

registerHandler("inbound.email", handler(handleEmail));
registerHandler("inbound.whatsapp", handler(handleWhatsApp));
