import { describe, expect, test } from "bun:test";
import { MemoryInbox } from "../src/app/inbox.ts";
import { newSessionRoute } from "../src/persistence/store.ts";
import type { InboundEnvelope } from "../src/channels/types.ts";
const msg = (id: string, text = id): InboundEnvelope => ({
  messageId: id,
  text,
  conversation: { channel: "feishu", conversationId: "c" },
  receivedAt: new Date().toISOString(),
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("in-memory inbound admission", () => {
  test("acceptance retains the full message before dispatch and deduplicates retries", async () => {
    const gate = deferred();
    let calls = 0;
    const inbox = new MemoryInbox(async () => {
      calls++;
      await gate.promise;
      return { duplicate: false, session: newSessionRoute("p") };
    });
    const accepted = inbox.accept(msg("a"));
    const retry = inbox.accept(msg("a"));
    expect(inbox.snapshot()[0]?.envelope.text).toBe("a");
    expect(retry.duplicate).toBe(true);
    gate.resolve();
    await Promise.all([accepted.completion, retry.completion]);
    expect(calls).toBe(1);
    await inbox.stop();
  });
  test("messages within a conversation dispatch in order", async () => {
    const gate = deferred();
    const order: string[] = [];
    const inbox = new MemoryInbox(async (e) => {
      order.push(e.messageId);
      if (e.messageId === "a") await gate.promise;
      return { duplicate: false, session: newSessionRoute("p") };
    });
    const a = inbox.accept(msg("a"));
    const b = inbox.accept(msg("b"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["a"]);
    gate.resolve();
    await b.completion;
    await a.completion;
    expect(order).toEqual(["a", "b"]);
    await inbox.stop();
  });
  test("capacity rejects ordinary messages while allowing controls", async () => {
    const gate = deferred();
    const inbox = new MemoryInbox(async () => {
      await gate.promise;
      return { duplicate: false, session: newSessionRoute("p") };
    }, 1);
    const a = inbox.accept(msg("a"));
    expect(() => inbox.accept(msg("b"))).toThrow("full");
    const control = inbox.accept(msg("cancel", "/cancel"));
    gate.resolve();
    await Promise.all([a.completion, control.completion]);
    await inbox.stop();
    expect(() => inbox.accept(msg("later"))).toThrow("stopping");
  });
  test("message IDs are scoped to a channel instance", async () => {
    let calls = 0;
    const inbox = new MemoryInbox(async () => {
      calls++;
      return { duplicate: false, session: newSessionRoute("p") };
    });
    await inbox.accept(msg("a")).completion;
    await inbox.accept({
      ...msg("a"),
      conversation: { ...msg("a").conversation, instanceId: "second-bot" },
    }).completion;
    expect(calls).toBe(2);
    await inbox.stop();
  });
  test("a failed message can be retried with the same ID", async () => {
    let attempts = 0;
    const inbox = new MemoryInbox(async () => {
      if (++attempts === 1) throw new Error("temporary failure");
      return { duplicate: false, session: newSessionRoute("p") };
    });
    await expect(inbox.accept(msg("retry")).completion).rejects.toThrow("temporary failure");
    const retried = inbox.accept(msg("retry"));
    expect(retried.duplicate).toBe(false);
    await retried.completion;
    expect(attempts).toBe(2);
    await inbox.stop();
  });
});
