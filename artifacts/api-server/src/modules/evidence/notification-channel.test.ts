import { test } from "node:test";
import assert from "node:assert/strict";
import { SendMessageBody } from "@workspace/api-zod";
import { messageChannelEnum } from "@workspace/db";
import {
  resetMessageTransport,
  sendMessage,
  setMessageTransport,
  TEMPLATES,
} from "../messaging/messaging";

test("in-app notifications are a real persisted channel, not an outbound send option", () => {
  assert.ok(messageChannelEnum.enumValues.includes("in_app"));
  assert.equal(
    SendMessageBody.safeParse({
      channel: "in_app",
      recipientRef: "ref-test",
      templateKey: "document_request_due",
    }).success,
    false,
  );
  for (const template of Object.values(TEMPLATES).filter((template) =>
    template.key.startsWith("document_request_"),
  )) {
    assert.deepEqual(template.channels, []);
  }
});

test("untyped inbox-channel submissions cannot reach a provider or database", async () => {
  let calls = 0;
  setMessageTransport(async () => {
    calls++;
    return { ok: true };
  });
  try {
    await assert.rejects(
      sendMessage({
        // @ts-expect-error Pin runtime protection for untyped callers as well.
        channel: "in_app",
        recipientRef: "ref-test",
        templateKey: "deadline_reminder",
      }),
      (error: unknown) =>
        (error as { code: string }).code === "CHANNEL_NOT_ALLOWED",
    );
    assert.equal(calls, 0);
  } finally {
    resetMessageTransport();
  }
});
