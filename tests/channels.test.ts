import { describe, expect, test } from "bun:test";
import { FeishuAdapter } from "../src/channels/feishu.ts";
import { Logger } from "../src/observability/logger.ts";

const logger = new Logger({ sink: () => {} });

describe("Feishu adapter", () => {
  test("answers URL verification with the challenge", async () => {
    const adapter = new FeishuAdapter(
      { enabled: true, verificationToken: "verify-token" },
      async () => undefined,
      logger,
    );
    const response = await adapter.handle(
      new Request("http://localhost/channels/feishu/events", {
        method: "POST",
        body: JSON.stringify({
          type: "url_verification",
          token: "verify-token",
          challenge: "challenge-value",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "challenge-value" });
  });

  test("normalizes text events without exposing Feishu payloads downstream", async () => {
    let received: any;
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const adapter = new FeishuAdapter(
      { enabled: true, verificationToken: "verify-token" },
      async (envelope) => {
        received = envelope;
        resolve();
      },
      logger,
    );
    const response = await adapter.handle(
      new Request("http://localhost/channels/feishu/events", {
        method: "POST",
        body: JSON.stringify({
          header: {
            event_id: "evt-1",
            event_type: "im.message.receive_v1",
            token: "verify-token",
          },
          event: {
            sender: { sender_type: "user", sender_id: { open_id: "ou-1" } },
            message: {
              message_id: "om-1",
              chat_id: "oc-1",
              chat_type: "p2p",
              message_type: "text",
              content: JSON.stringify({ text: "Analyze the repository" }),
            },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 0 });
    await done;
    expect(received).toMatchObject({
      messageId: "om-1",
      conversation: { channel: "feishu", conversationId: "oc-1" },
      senderId: "ou-1",
      text: "Analyze the repository",
    });
  });

  test("rejects an invalid verification token", async () => {
    const adapter = new FeishuAdapter(
      { enabled: true, verificationToken: "expected" },
      async () => undefined,
      logger,
    );
    const response = await adapter.handle(
      new Request("http://localhost/channels/feishu/events", {
        method: "POST",
        body: JSON.stringify({ type: "url_verification", token: "wrong", challenge: "x" }),
      }),
    );
    expect(response.status).toBe(401);
  });
});
