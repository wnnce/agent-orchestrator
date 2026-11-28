import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createAppServices } from "../src/app/index.ts";
import type { ChannelHooks, InboundCommand, InboundEnvelope } from "../src/channels/types.ts";
import type { AppConfig } from "../src/config/config.ts";
import type { ProjectConfig, SessionRoute } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";

const project: ProjectConfig = {
  id: "inbound-proj",
  displayName: "Inbound",
  description: "",
  routing: { projectId: "inbound-proj", displayName: "Inbound", summary: "", keywords: [] },
  runtime: { type: "fake" },
  repository: { url: "", baseBranch: "main" },
};

const config = {
  dataDir: "/tmp/inbound-service-test-data",
  artifactDir: "/tmp/inbound-service-test-artifacts",
  routerBaseUrl: "http://localhost:1/v1",
} as AppConfig;

/** Records what the inbound service asks of its channel. */
class RecordingChannel implements ChannelHooks {
  readonly id = "http" as const;
  readonly prepared: string[] = [];
  readonly undone: string[] = [];
  readonly commands: Array<{ command: InboundCommand; session: SessionRoute | undefined }> = [];

  beforeTurn(envelope: InboundEnvelope): () => void {
    this.prepared.push(envelope.messageId);
    return () => this.undone.push(envelope.messageId);
  }

  async afterCommand(
    _envelope: InboundEnvelope,
    command: InboundCommand,
    session: SessionRoute | undefined,
  ): Promise<void> {
    this.commands.push({ command, session });
  }
}

let nextMessage = 0;
function message(conversationId: string, text: string): InboundEnvelope {
  return {
    messageId: `msg-${++nextMessage}`,
    conversation: { channel: "http", conversationId },
    projectId: project.id,
    text,
    receivedAt: new Date().toISOString(),
  };
}

describe("InboundService", () => {
  const logger = new Logger({ level: "error" });
  const store = new MemoryStore();
  const projects = new ProjectManager([project], store, config, logger);
  const channel = new RecordingChannel();
  const { inbound } = createAppServices({ config, store, projects, logger, channels: [channel] });
  beforeAll(() => projects.start());
  afterAll(async () => {
    await inbound.stop();
    await projects.stop();
  });

  it("opens one session per conversation and processes each message once", async () => {
    const first = message("conv-a", "hello");
    const result = await inbound.handle(first);
    expect(result.duplicate).toBe(false);
    expect(result.turn?.input).toBe("hello");
    expect(channel.prepared).toContain(first.messageId);

    const again = await inbound.handle(first);
    expect(again.duplicate).toBe(true);
    expect(again.session?.sessionId).toBe(result.session?.sessionId);

    const second = await inbound.handle(message("conv-a", "and again"));
    expect(second.session?.sessionId).toBe(result.session?.sessionId);
  });

  it("undoes the reply and releases the message when submitting fails", async () => {
    const runtime = projects.get(project.id);
    const turn = runtime.turns.submit.bind(runtime.turns);
    runtime.turns.submit = async () => {
      throw new Error("admission failed");
    };
    const failing = message("conv-b", "hello");
    try {
      await expect(inbound.handle(failing)).rejects.toThrow("admission failed");
    } finally {
      runtime.turns.submit = turn;
    }
    expect(channel.undone).toEqual([failing.messageId]);
    expect(store.inboundMessages.has(failing.messageId)).toBe(false);

    const retried = await inbound.handle(failing);
    expect(retried.duplicate).toBe(false);
    expect(retried.turn).toBeDefined();
  });

  it("answers /cancel and /close without a session instead of inventing one", async () => {
    const cancel = await inbound.handle(message("conv-empty", "/cancel"));
    const close = await inbound.handle(message("conv-empty", "/close"));
    expect(cancel).toEqual({ duplicate: false, command: "cancel" });
    expect(close).toEqual({ duplicate: false, command: "close" });
    expect(channel.commands.slice(-2)).toEqual([
      { command: "cancel", session: undefined },
      { command: "close", session: undefined },
    ]);
  });

  it("closes the conversation's session on /close", async () => {
    const opened = await inbound.handle(message("conv-c", "hello"));
    const sessionId = opened.session!.sessionId;
    await projects.get(project.id).turns.waitForIdle(sessionId);

    const closed = await inbound.handle(message("conv-c", "/close"));
    expect(closed.command).toBe("close");
    expect(closed.session?.sessionId).toBe(sessionId);
    expect(channel.commands.at(-1)?.session?.sessionId).toBe(sessionId);
    expect(await store.getSession(sessionId)).toBeNull();
  });
});
