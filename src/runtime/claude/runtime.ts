import path from "node:path";
import { mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { query as sdkQuery, type SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ActionRegistry } from "../../actions/registry.ts";
import type { ProjectConfig } from "../../domain/types.ts";
import { Logger } from "../../observability/logger.ts";
import type {
  AgentRuntime,
  ApprovalDecision,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeSession,
  RuntimeTurn,
} from "../runtime.ts";
import { CLAUDE_CAPABILITIES } from "./capabilities.ts";
import { buildQueryOptions } from "./options.ts";
import { ClaudeSession, type ClaudeQueryFn } from "./session.ts";
import { createActionServer } from "./tools.ts";
import { projectSkillSources, type SkillSource } from "../skills.ts";

/**
 * Claude Code through the Claude Agent SDK. Each session runs its own Claude Code process,
 * which `releaseSession` ends; ProjectRuntime releases idle sessions. Claude Code reads its own
 * configuration (CLAUDE_CONFIG_DIR, by default ~/.claude); see `buildQueryOptions` for what a
 * session adds.
 */
export class ClaudeRuntime implements AgentRuntime {
  readonly name = "claude";
  readonly type = "claude" as const;
  readonly capabilities: RuntimeCapabilities = CLAUDE_CAPABILITIES;

  private readonly sessions = new Map<string, ClaudeSession>();

  constructor(
    private readonly logger = new Logger(),
    private readonly globalProject?: ProjectConfig | undefined,
    private readonly actionRegistry?: ActionRegistry | undefined,
    /** Service data directory; skill plugins are generated under <dataDir>/claude-plugins. */
    private readonly dataDir = ".data",
    private readonly query: ClaudeQueryFn = sdkQuery,
  ) {}

  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    const session = await this.open(context, crypto.randomUUID(), false);
    return { id: session.id, workspacePath: context.workspacePath };
  }

  async resumeSession(context: RuntimeContext, runtimeSessionId: string): Promise<RuntimeSession> {
    const existing = this.sessions.get(runtimeSessionId);
    if (existing) existing.context = context;
    else await this.open(context, runtimeSessionId, true);
    return { id: runtimeSessionId, workspacePath: context.workspacePath };
  }

  async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    const session = this.session(sessionId);
    session.context = context;
    return { id: session.startTurn(turnId, input) };
  }

  async steerTurn(
    _context: RuntimeContext,
    sessionId: string,
    _runtimeTurnId: string,
    input: string,
  ): Promise<void> {
    this.session(sessionId).steer(input);
  }

  async interruptTurn(
    _context: RuntimeContext,
    sessionId: string,
    _runtimeTurnId: string,
  ): Promise<void> {
    await this.sessions.get(sessionId)?.interrupt();
  }

  async compactSession(_context: RuntimeContext, sessionId: string): Promise<void> {
    await this.session(sessionId).compact();
  }

  async respondToApproval(
    _context: RuntimeContext,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const session = [...this.sessions.values()].find((s) => s.hasApproval(requestId));
    if (!session) throw new Error(`no pending approval request: ${requestId}`);
    session.respondToApproval(requestId, decision);
  }

  async releaseSession(_context: RuntimeContext, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.close();
    this.logger.info("claude code session released", { sessionId });
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private session(sessionId: string): ClaudeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Claude session not found: ${sessionId}`);
    return session;
  }

  private async open(
    context: RuntimeContext,
    sessionId: string,
    resume: boolean,
  ): Promise<ClaudeSession> {
    const plugins = await Promise.all(
      projectSkillSources(context.project, this.globalProject).map((source) =>
        this.skillPlugin(context.project, source),
      ),
    );

    const session: ClaudeSession = new ClaudeSession({
      id: sessionId,
      resume,
      context,
      logger: this.logger,
      query: this.query,
      options: (canUseTool) =>
        buildQueryOptions({
          project: context.project,
          workspacePath: context.workspacePath,
          sessionId,
          resume,
          readOnly: context.readOnly,
          plugins,
          actionServer:
            this.actionRegistry &&
            createActionServer(
              this.actionRegistry,
              context.taskKey,
              () => ({
                project: session.context.project,
                workspacePath: session.context.workspacePath,
                sessionId,
                taskKey: session.context.taskKey,
                actionScope: session.context.actionScope,
                actionParameterOverrides: session.context.actionParameterOverrides,
                createActionContext: session.context.createActionContext,
                logger: this.logger,
              }),
              context.actionScope,
              context.actionParameterOverrides,
            ),
          canUseTool,
          stderr: (data) => this.logger.debug("claude code stderr", { sessionId, data }),
        }),
      onExit: (exited) => {
        if (this.sessions.get(exited.id) === exited) this.sessions.delete(exited.id);
      },
    });
    await session.open();
    this.sessions.set(sessionId, session);
    this.logger.info(resume ? "claude code session resumed" : "claude code session started", {
      sessionId,
      projectId: context.project.id,
    });
    return session;
  }

  /**
   * Claude Code loads extra skills only from plugins, so each skills directory is wrapped in a
   * generated local plugin whose `skills` links to it. Its skills appear as `<plugin>:<skill>`.
   */
  private async skillPlugin(project: ProjectConfig, source: SkillSource): Promise<SdkPluginConfig> {
    const name = source.projectId === project.id ? project.id : "global";
    const dir = path.resolve(this.dataDir, "claude-plugins", project.id, name);
    await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", description: `Skills of ${source.projectId}` }),
    );
    const link = path.join(dir, "skills");
    if ((await readlink(link).catch(() => undefined)) !== source.dir) {
      await rm(link, { force: true });
      await symlink(source.dir, link, "dir").catch((error: NodeJS.ErrnoException) => {
        // Another session of the project created it at the same moment.
        if (error.code !== "EEXIST") throw error;
      });
    }
    return { type: "local", path: dir };
  }
}
