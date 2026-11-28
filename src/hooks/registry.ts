import { ErrorCode, NotFoundError } from "../domain/errors.ts";
import type { Logger } from "../observability/logger.ts";
import { deliverHook, type HookContextFactory } from "./deliver.ts";
import { loadProjectHooks, type LoadedHook } from "./loader.ts";

/** A hook as listed: what it is, not how it runs. */
export interface HookSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** The HTTP hooks of one project (`projects/<id>/hooks/`), loaded when the project starts. */
export class ProjectHooks {
  private hooks = new Map<string, LoadedHook>();

  constructor(
    private readonly projectId: string,
    private readonly createContext: HookContextFactory,
    private readonly logger: Logger,
  ) {}

  async load(projectDir: string): Promise<void> {
    this.hooks = await loadProjectHooks(projectDir, this.projectId, this.logger);
    if (this.hooks.size > 0) {
      this.logger.info("project hooks loaded", {
        projectId: this.projectId,
        hooks: [...this.hooks.keys()],
      });
    }
  }

  list(): HookSummary[] {
    return [...this.hooks.values()].map((hook) => ({
      id: hook.id,
      name: hook.name,
      ...(hook.description ? { description: hook.description } : {}),
    }));
  }

  /** Hands an HTTP request to hook `hookId` and returns its response. */
  async handle(hookId: string, request: Request): Promise<Response> {
    const hook = this.hooks.get(hookId);
    if (!hook) {
      throw new NotFoundError(
        `hook ${hookId} not found in project ${this.projectId}`,
        ErrorCode.HOOK_NOT_FOUND,
      );
    }
    return deliverHook(hook, request, this.createContext);
  }
}
