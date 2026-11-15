import { describe, expect, it } from "bun:test";
import { FeishuWSAdapter } from "../src/channels/feishu/ws.ts";
import { Logger } from "../src/observability/logger.ts";
import type { InboundEnvelope } from "../src/channels/types.ts";

describe("FeishuWSAdapter", () => {
  const logger = new Logger({ level: "error" });

  it("parses normal user text message into InboundEnvelope", () => {
    let captured: InboundEnvelope | undefined;
    const adapter = new FeishuWSAdapter(
      { appId: "cli_test", appSecret: "sec_test" },
      async (env) => {
        captured = env;
      },
      logger,
    );

    const eventData = {
      message: {
        message_id: "om_test_123",
        chat_id: "oc_test_chat",
        message_type: "text",
        content: JSON.stringify({ text: "Hello from Feishu!" }),
        root_id: "om_root_123",
      },
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_test_user",
        },
      },
    };

    const envelope = adapter.parseWSMessage(eventData);
    expect(envelope).toBeDefined();
    expect(envelope!.messageId).toBe("om_test_123");
    expect(envelope!.conversation.channel).toBe("feishu");
    expect(envelope!.conversation.conversationId).toBe("oc_test_chat");
    expect(envelope!.conversation.threadId).toBe("om_root_123");
    expect(envelope!.senderId).toBe("ou_test_user");
    expect(envelope!.text).toBe("Hello from Feishu!");
  });

  it("strips bot @mention tags in group messages", () => {
    const adapter = new FeishuWSAdapter(
      { appId: "cli_test", appSecret: "sec_test" },
      async () => {},
      logger,
    );

    const eventData = {
      message: {
        message_id: "om_456",
        chat_id: "oc_group_chat",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 请帮我分析项目" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_test_user" },
      },
    };

    const envelope = adapter.parseWSMessage(eventData);
    expect(envelope).toBeDefined();
    expect(envelope!.text).toBe("请帮我分析项目");
  });

  it("ignores messages from app/bot sender", () => {
    const adapter = new FeishuWSAdapter(
      { appId: "cli_test", appSecret: "sec_test" },
      async () => {},
      logger,
    );

    const eventData = {
      message: {
        message_id: "om_789",
        chat_id: "oc_chat",
        message_type: "text",
        content: JSON.stringify({ text: "bot message" }),
      },
      sender: {
        sender_type: "app",
      },
    };

    const envelope = adapter.parseWSMessage(eventData);
    expect(envelope).toBeUndefined();
  });

  it("ignores non-text messages (e.g. image)", () => {
    const adapter = new FeishuWSAdapter(
      { appId: "cli_test", appSecret: "sec_test" },
      async () => {},
      logger,
    );

    const eventData = {
      message: {
        message_id: "om_image",
        chat_id: "oc_chat",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_xxx" }),
      },
      sender: {
        sender_type: "user",
      },
    };

    const envelope = adapter.parseWSMessage(eventData);
    expect(envelope).toBeUndefined();
  });
});
