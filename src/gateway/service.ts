import type { AppConfig } from "../config/config.ts";
import type { SessionRoute, TurnRecord } from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";
import { ProjectManager } from "../project/manager.ts";
import { ProjectRouter } from "../router/project-router.ts";
import type { InboundEnvelope, InboundResult } from "../channels/types.ts";
import type { Logger } from "../observability/logger.ts";
import type { EventHub } from "../events/hub.ts";
import { FeishuClient, FeishuSessionStreamer, buildFeishuCard } from "../channels/feishu.ts";
import {
  WeComClient,
  WeComSessionStreamer,
  buildWeComCancelMessage,
  buildWeComCloseMessage,
  type WeComTurnContext,
} from "../channels/wecom.ts";
import type { SessionManager } from "../session/index.ts";
import { MemoryInbox } from "./inbox.ts";
import { SessionTitleGenerator } from "./titles.ts";

export interface CreateSessionInput {
  projectId?: string;
  title?: string;
  query?: string;
  submitQuery?: boolean;
  repositoryId?: string;
  source?: string;
  external?: {
    channel: string;
    conversationId: string;
    threadId?: string;
  };
}

export interface CreatedSession {
  session: SessionRoute;
  routedProject: string;
  turn?: TurnRecord;
}

/** Transport-neutral application entry point for sessions and inbound messages. */
export class GatewayService {
  private readonly router: ProjectRouter;
  private readonly titles: SessionTitleGenerator;
  readonly inbox: MemoryInbox;
  private readonly feishuClient?: FeishuClient;
  private readonly feishuStreamer?: FeishuSessionStreamer;
  private readonly wecomClient?: WeComClient;
  private readonly wecomStreamer?: WeComSessionStreamer;
  private readonly sessionManager: SessionManager;
  private readonly feishuCloseObservers = new Map<string, () => void>();
  private readonly wecomCloseObservers = new Map<string, () => void>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly projects: ProjectManager,
    private readonly logger: Logger,
    private readonly eventHub: EventHub = projects.eventHub,
    feishuClient?: FeishuClient,
    sessionManager?: SessionManager,
    wecomClient?: WeComClient,
  ) {
    this.sessionManager = sessionManager ?? projects.sessionManager;
    this.router = new ProjectRouter(config.routerApiKey, config.routerModel, config.routerBaseUrl);
    this.titles = new SessionTitleGenerator(config.titles, logger);
    this.inbox = new MemoryInbox((envelope) => this.processInbound(envelope));
    if (config.feishu?.appId && config.feishu?.appSecret) {
      this.feishuClient =
        feishuClient ??
        new FeishuClient(
          {
            appId: config.feishu.appId,
            appSecret: config.feishu.appSecret,
            ...(config.feishu.apiBaseUrl ? { apiBaseUrl: config.feishu.apiBaseUrl } : {}),
          },
          logger,
        );
      this.feishuStreamer = new FeishuSessionStreamer(this.eventHub, this.feishuClient, logger);
    } else if (feishuClient) {
      this.feishuClient = feishuClient;
      this.feishuStreamer = new FeishuSessionStreamer(this.eventHub, this.feishuClient, logger);
    }

    if (config.wecom?.botId && config.wecom?.secret) {
      this.wecomClient =
        wecomClient ??
        new WeComClient(
          {
            botId: config.wecom.botId,
            secret: config.wecom.secret,
            ...(config.wecom.wsUrl ? { wsUrl: config.wecom.wsUrl } : {}),
          },
          logger,
        );
      this.wecomStreamer = new WeComSessionStreamer(this.eventHub, this.wecomClient, logger);
    } else if (wecomClient) {
      this.wecomClient = wecomClient;
      this.wecomStreamer = new WeComSessionStreamer(this.eventHub, this.wecomClient, logger);
    }
  }

  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    const query = input.query?.trim() ?? "";
    const projectId = input.projectId?.trim() ?? "";
    const explicitTitle = input.title?.trim();
    const project = projectId
      ? this.projects.get(projectId)
      : this.projects.get(
          (
            await this.router.route(query, this.projects.list(), {
              enableGlobalFallback: true,
              globalProject: this.projects.getGlobalProject(),
            })
          ).project.id,
        );
    const source = input.source ?? input.external?.channel ?? "web";
    let route = await project.createSession(
      input.repositoryId,
      explicitTitle ? { title: explicitTitle } : undefined,
      source,
    );
    if (input.external) route = await project.bindExternal(route.sessionId, input.external);
    const turn =
      query && input.submitQuery !== false ? await project.turn(route.sessionId, query) : undefined;
    if (query && !explicitTitle) {
      this.generateSessionTitle(route.sessionId, query);
    }
    return { session: route, routedProject: project.project.id, ...(turn ? { turn } : {}) };
  }

  async submitTurn(sessionId: string, input: string): Promise<TurnRecord> {
    const route = await this.store.getSession(sessionId);
    if (!route) throw new Error("session_not_found");
    if (!route.title) this.generateSessionTitle(sessionId, input);
    return this.projects.get(route.projectId).turn(sessionId, input);
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const route = await this.store.getSession(sessionId);
    if (!route) return false;
    return this.projects.get(route.projectId).renameSession(sessionId, title);
  }

  /** Names the session after `query` in the background, unless it gets a title first. */
  generateSessionTitle(sessionId: string, query: string): void {
    void this.titles
      .generate(query)
      .then(async (title) => {
        if (!title) return;
        const route = await this.store.getSession(sessionId);
        if (route) await this.projects.get(route.projectId).setGeneratedTitle(sessionId, title);
      })
      .catch((error) =>
        this.logger.warn("failed to set generated session title", { sessionId, error }),
      );
  }

  async acceptInbound(envelope: InboundEnvelope): Promise<{ duplicate: boolean }> {
    const receipt = this.inbox.accept(envelope);
    void receipt.completion.catch((error) =>
      this.logger.error("inbox message failed", { messageId: envelope.messageId, error }),
    );
    return { duplicate: receipt.duplicate };
  }
  async handleInbound(envelope: InboundEnvelope): Promise<InboundResult> {
    return this.inbox.accept(envelope).completion;
  }
  async stop(): Promise<void> {
    await this.inbox.stop();
    await this.feishuStreamer?.stop();
    for (const unsubscribe of this.feishuCloseObservers.values()) unsubscribe();
    this.feishuCloseObservers.clear();
    await this.wecomStreamer?.stop();
    for (const unsubscribe of this.wecomCloseObservers.values()) unsubscribe();
    this.wecomCloseObservers.clear();
  }

  private registerWeComCloseObserver(sessionId: string, chatId: string): void {
    if (!this.wecomClient?.isConfigured() || !this.wecomStreamer) return;
    if (this.wecomCloseObservers.has(sessionId)) return;
    let unsubscribe!: () => void;
    unsubscribe = this.sessionManager.observe(async (event) => {
      if (event.type !== "destroyed" || event.session.sessionId !== sessionId) return;
      this.wecomCloseObservers.delete(sessionId);
      unsubscribe();
      await this.wecomStreamer?.closeSession(sessionId);
      await this.wecomClient
        ?.sendMessage(chatId, {
          msgtype: "markdown",
          markdown: {
            content: buildWeComCloseMessage(),
          },
        })
        .catch((error) =>
          this.logger.warn("failed to send WeCom session close message", {
            sessionId,
            error: (error as Error).message,
          }),
        );
    });
    this.wecomCloseObservers.set(sessionId, unsubscribe);
  }

  private registerFeishuCloseObserver(sessionId: string, chatId: string, rootId: string): void {
    if (!this.feishuClient?.isConfigured() || !this.feishuStreamer) return;
    if (this.feishuCloseObservers.has(sessionId)) return;
    let unsubscribe!: () => void;
    unsubscribe = this.sessionManager.observe(async (event) => {
      if (event.type !== "destroyed" || event.session.sessionId !== sessionId) return;
      this.feishuCloseObservers.delete(sessionId);
      unsubscribe();
      await this.feishuStreamer?.closeSession(sessionId);
      await this.feishuClient
        ?.sendCard({
          receiveId: chatId,
          receiveIdType: "chat_id",
          rootId,
          card: buildFeishuCard({
            title: "✅ 会话已关闭",
            headerTemplate: "grey",
            statusLine: "已退出会话",
            contentMarkdown:
              "当前会话已成功关闭，相关的 Git 工作区与进程资源已安全释放。\n\n如需开启新的任务，请直接发送具体需求。",
            isFinished: true,
          }),
        })
        .catch((error) =>
          this.logger.warn("failed to send Feishu session close card", {
            sessionId,
            error,
          }),
        );
    });
    this.feishuCloseObservers.set(sessionId, unsubscribe);
  }

  private async processInbound(envelope: InboundEnvelope): Promise<InboundResult> {
    const text = envelope.text.trim();
    if (!text) throw new Error("inbound message text is required");

    const existing = await this.store.findSessionByExternal(
      envelope.conversation.channel,
      envelope.conversation.conversationId,
      envelope.conversation.threadId,
    );
    const claimed = await this.store.claimInboundMessage({
      messageId: envelope.messageId,
      channel: envelope.conversation.channel,
      conversationId: envelope.conversation.conversationId,
      ...(envelope.conversation.threadId ? { threadId: envelope.conversation.threadId } : {}),
      ...(existing ? { sessionId: existing.sessionId } : {}),
      receivedAt: envelope.receivedAt,
    });
    if (!claimed) {
      const session =
        existing ??
        (await this.store.findSessionByExternal(
          envelope.conversation.channel,
          envelope.conversation.conversationId,
          envelope.conversation.threadId,
        ));
      if (!session) throw new Error("duplicate inbound message is still being processed");
      this.logger.info("duplicate inbound message ignored", {
        channel: envelope.conversation.channel,
        messageId: envelope.messageId,
        sessionId: session.sessionId,
      });
      return { duplicate: true, session };
    }

    if (/^\/cancel(?:\s|$)/i.test(text)) {
      try {
        if (existing) {
          await this.projects
            .get(existing.projectId)
            .interrupt(existing.sessionId, text.split(/\s+/)[1]);
        }
      } catch (error) {
        await this.store.releaseInboundMessage(envelope.messageId);
        throw error;
      }
      if (envelope.conversation.channel === "feishu" && this.feishuClient?.isConfigured()) {
        await this.feishuClient
          .sendCard({
            receiveId: envelope.conversation.conversationId,
            rootId: envelope.conversation.threadId || envelope.messageId,
            card: buildFeishuCard({
              title: "会话",
              headerTemplate: "grey",
              statusLine: existing ? "当前任务已取消" : "无活跃会话",
              isFinished: true,
            }),
          })
          .catch((error) => {
            this.logger.warn("failed to send Feishu cancel confirmation card", { error });
          });
      }
      if (envelope.conversation.channel === "wecom" && this.wecomClient?.isConfigured()) {
        const reqId = envelope.metadata?.reqId ? String(envelope.metadata.reqId) : "";
        const streamId = String(envelope.metadata?.streamId ?? `stream_${envelope.messageId}`);
        const cancelMsg = buildWeComCancelMessage(Boolean(existing));
        if (reqId) {
          await this.wecomClient.replyStream(reqId, streamId, cancelMsg, true).catch((error) => {
            this.logger.warn("failed to send WeCom cancel confirmation stream", { error });
          });
        } else {
          await this.wecomClient
            .sendMessage(envelope.conversation.conversationId, {
              msgtype: "markdown",
              markdown: { content: cancelMsg },
            })
            .catch((error) => {
              this.logger.warn("failed to send WeCom cancel confirmation message", { error });
            });
        }
      }
      return {
        duplicate: false,
        session: existing ?? {
          sessionId: "none",
          projectId: "none",
          projectRuntimeId: "none",
          runtimeSessionId: null,
          configRevision: 1,
          status: "archived",
          lastActiveAt: new Date().toISOString(),
        },
        command: "cancel",
      };
    }

    // Handle /close command
    if (text.toLowerCase() === "/close") {
      if (existing) {
        try {
          const project = this.projects.get(existing.projectId);
          await project.cleanupSession(existing.sessionId);
        } catch (error) {
          await this.store.releaseInboundMessage(envelope.messageId);
          throw error;
        }
        this.logger.info("session closed via /close command", {
          channel: envelope.conversation.channel,
          sessionId: existing.sessionId,
          conversationId: envelope.conversation.conversationId,
        });

        return { duplicate: false, session: existing, command: "close" };
      }

      return {
        duplicate: false,
        session: {
          sessionId: "none",
          projectId: "none",
          projectRuntimeId: "none",
          runtimeSessionId: null,
          configRevision: 1,
          status: "archived",
          lastActiveAt: new Date().toISOString(),
        },
        command: "close",
      };
    }

    let session: SessionRoute;
    let turn: TurnRecord;
    let feishuTurnContext: { chatId: string; rootId?: string; projectId?: string } | undefined;
    let wecomTurnContext: WeComTurnContext | undefined;
    try {
      session = existing
        ? existing
        : (
            await this.createSession({
              ...(envelope.projectId ? { projectId: envelope.projectId } : {}),
              query: text,
              submitQuery: false,
              source: envelope.conversation.channel,
              external: envelope.conversation,
            })
          ).session;
      if (envelope.conversation.channel === "feishu" && this.feishuStreamer) {
        this.feishuStreamer.ensureSession({
          sessionId: session.sessionId,
          chatId: envelope.conversation.conversationId,
          projectId: session.projectId,
          source: "feishu",
        });
        this.registerFeishuCloseObserver(
          session.sessionId,
          envelope.conversation.conversationId,
          envelope.conversation.threadId || envelope.messageId,
        );
        feishuTurnContext = {
          chatId: envelope.conversation.conversationId,
          ...(envelope.conversation.threadId
            ? { rootId: envelope.conversation.threadId }
            : { rootId: envelope.messageId }),
          projectId: session.projectId,
        };
        this.feishuStreamer.enqueueTurn(session.sessionId, feishuTurnContext);
      }
      if (envelope.conversation.channel === "wecom" && this.wecomStreamer) {
        const chatId = envelope.conversation.conversationId;
        const reqId = envelope.metadata?.reqId ? String(envelope.metadata.reqId) : undefined;
        const streamId = String(envelope.metadata?.streamId ?? `stream_${envelope.messageId}`);

        this.wecomStreamer.ensureSession({
          sessionId: session.sessionId,
          chatId,
          projectId: session.projectId,
          source: "wecom",
        });
        this.registerWeComCloseObserver(session.sessionId, chatId);
        wecomTurnContext = {
          chatId,
          ...(reqId ? { reqId } : {}),
          streamId,
          projectId: session.projectId,
        };
        this.wecomStreamer.enqueueTurn(session.sessionId, wecomTurnContext);
      }
      turn = await this.submitTurn(session.sessionId, text);
    } catch (error) {
      if (feishuTurnContext)
        this.feishuStreamer?.discardTurn(session!.sessionId, feishuTurnContext);
      if (wecomTurnContext)
        this.wecomStreamer?.discardTurn(session!.sessionId, wecomTurnContext);
      await this.store.releaseInboundMessage(envelope.messageId);
      throw error;
    }
    this.logger.info("inbound message accepted", {
      channel: envelope.conversation.channel,
      messageId: envelope.messageId,
      sessionId: session.sessionId,
      turnId: turn.id,
    });
    return { duplicate: false, session, turn };
  }
}
