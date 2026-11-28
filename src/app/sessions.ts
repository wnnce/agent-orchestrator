import { ErrorCode, ForbiddenError } from "../domain/errors.ts";
import type { SessionRoute, TurnRecord } from "../domain/types.ts";
import type { Logger } from "../observability/logger.ts";
import type { ProjectManager } from "../project/manager.ts";
import type { ProjectRouter } from "../router/project-router.ts";
import type { SessionTitleGenerator } from "./titles.ts";

export interface CreateSessionInput {
  projectId?: string | undefined;
  title?: string | undefined;
  query?: string | undefined;
  /** Submit `query` as the first turn. Defaults to true. */
  submitQuery?: boolean | undefined;
  source?: string | undefined;
  runtime?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: string | undefined;
  external?:
    | {
        channel: string;
        conversationId: string;
        threadId?: string | undefined;
      }
    | undefined;
}

export interface CreatedSession {
  session: SessionRoute;
  routedProject: string;
  turn?: TurnRecord;
}

export interface SessionServiceDeps {
  readonly projects: ProjectManager;
  readonly router: ProjectRouter;
  readonly titles: SessionTitleGenerator;
  readonly logger: Logger;
}

/** Sessions as people outside the service use them, whichever way their input arrives. */
export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  /**
   * Opens a session in `input.projectId`, or in the project the router picks for `input.query`,
   * and submits the query as its first turn.
   */
  async create(input: CreateSessionInput): Promise<CreatedSession> {
    const query = input.query?.trim() ?? "";
    const explicitTitle = input.title?.trim();
    const project = this.deps.projects.get(
      input.projectId?.trim() || (await this.routeQuery(query)),
    );
    const source = input.source ?? input.external?.channel ?? "web";
    const runtimeOverride =
      input.runtime || input.model || input.reasoningEffort
        ? {
            ...(input.runtime ? { runtime: input.runtime } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          }
        : undefined;
    let session = await project.sessions.create({
      title: explicitTitle,
      source,
      runtime: runtimeOverride,
    });
    if (input.external) {
      session = await project.sessions.bindExternal(session.sessionId, {
        channel: input.external.channel,
        conversationId: input.external.conversationId,
        ...(input.external.threadId ? { threadId: input.external.threadId } : {}),
      });
    }
    const turn =
      query && input.submitQuery !== false
        ? await project.turns.submit(session.sessionId, query)
        : undefined;
    if (query && !explicitTitle) this.nameAfter(session.sessionId, query);
    return { session, routedProject: project.project.id, ...(turn ? { turn } : {}) };
  }

  /**
   * Submits a person's message as a new turn. Task sessions are driven by their task alone,
   * so they refuse it.
   */
  async submitTurn(sessionId: string, input: string): Promise<TurnRecord> {
    const runtime = await this.deps.projects.runtimeForSession(sessionId);
    const session = await runtime.sessions.get(sessionId);
    if (session.source === "task") {
      throw new ForbiddenError(
        "Task session is automated and read-only; manual turn input is disabled.",
        ErrorCode.TASK_SESSION_READ_ONLY,
      );
    }
    if (!session.title) this.nameAfter(sessionId, input);
    return runtime.turns.submit(sessionId, input);
  }

  private async routeQuery(query: string): Promise<string> {
    const { project } = await this.deps.router.route(query, this.deps.projects.list(), {
      enableGlobalFallback: true,
      globalProject: this.deps.projects.getGlobalProject(),
    });
    return project.id;
  }

  /** Names the session after `message` in the background, unless it gets a title first. */
  private nameAfter(sessionId: string, message: string): void {
    void this.deps.titles
      .generate(message)
      .then(async (title) => {
        if (!title) return;
        const runtime = await this.deps.projects.runtimeForSession(sessionId);
        await runtime.sessions.setGeneratedTitle(sessionId, title);
      })
      .catch((error) =>
        this.deps.logger.warn("failed to set generated session title", { sessionId, error }),
      );
  }
}
