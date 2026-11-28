import { access } from "node:fs/promises";
import type { ProjectConfig, SessionRoute } from "../domain/types.ts";
import type { Logger } from "../observability/logger.ts";
import type { WorkspaceManager } from "../workspace/workspace.ts";

/** The working directories of one project's sessions. */
export class SessionWorkspaces {
  constructor(
    private readonly project: ProjectConfig,
    private readonly workspaces: WorkspaceManager,
    private readonly logger: Logger,
  ) {}

  /** Creates the worktree of a new session and returns its path. */
  create(sessionId: string): Promise<string> {
    return this.workspaces.ensureSessionWorkspace(this.project, sessionId);
  }

  /**
   * The session's working directory. It is stored when the session is created; sessions created
   * before that was stored get it computed. Never touches git.
   */
  path(route: SessionRoute): string {
    return route.workspacePath ?? this.workspaces.sessionPath(this.project, route.sessionId);
  }

  /**
   * The session's working directory, ready for a turn. A session's own worktree is recreated
   * when it is missing, e.g. after the data dir was cleaned; a pipeline session shares the run's
   * worktree, which it never recreates.
   */
  async prepare(route: SessionRoute): Promise<string> {
    if (route.source === "pipeline") {
      const workspacePath = route.workspacePath;
      if (!workspacePath) {
        throw new Error(`pipeline session ${route.sessionId} has no workspacePath`);
      }
      try {
        await access(workspacePath);
      } catch {
        throw new Error(`pipeline workspace is missing or already cleaned: ${workspacePath}`);
      }
      return workspacePath;
    }
    if (!this.workspaces.isSessionReady(this.project, route.sessionId)) {
      this.logger.warn("session workspace is missing; recreating it", {
        projectId: this.project.id,
        sessionId: route.sessionId,
      });
      await this.workspaces.ensureSessionWorkspace(this.project, route.sessionId);
    }
    return this.path(route);
  }

  /** Removes the session's own worktree. */
  remove(sessionId: string): Promise<void> {
    return this.workspaces.removeSession(this.project, sessionId);
  }
}
