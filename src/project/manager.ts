import { ErrorCode, NotFoundError } from "../domain/errors.ts";
import type { NotificationConfig, ProjectConfig } from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import { RuntimeRegistry, defaultRuntimeRegistry, type AgentRuntime } from "../runtime/index.ts";
import { ProjectRuntime } from "./runtime.ts";
import type { AppConfig } from "../config/config.ts";
import path from "node:path";
import type { Logger } from "../observability/logger.ts";
import { NotificationHub, NotificationOutbox } from "../notifications/index.ts";
import { MemoryEventHub, type EventHub } from "../events/hub.ts";
import { SkillManager, type ProjectSkill } from "./skills.ts";
import { GLOBAL_PROJECT_ID, createGlobalProjectConfig } from "./global.ts";
import { SessionManager } from "../session/index.ts";
import { ActionRegistry, defaultActionRegistry } from "../actions/index.ts";
import { PipelineEventHub } from "../pipeline/index.ts";

export class ProjectManager {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  readonly eventHub: EventHub;
  readonly pipelineEventHub = new PipelineEventHub();
  private readonly globalProject: ProjectConfig;

  constructor(
    private readonly projects: ProjectConfig[],
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    eventHub?: EventHub,
    readonly sessionManager: SessionManager = new SessionManager(store, logger),
    private readonly runtimeRegistry: RuntimeRegistry = defaultRuntimeRegistry,
  ) {
    this.eventHub = eventHub ?? new MemoryEventHub(store, sessionManager);
    const globalProjectsDir = path.resolve(process.cwd(), "projects");
    this.globalProject = createGlobalProjectConfig(globalProjectsDir, this.defaultRuntime);
  }

  private get defaultRuntime(): string {
    return this.config.defaultRuntime ?? "codex";
  }

  getDefaultRuntime(): string {
    return this.defaultRuntime;
  }

  getRuntimeRegistry(): RuntimeRegistry {
    return this.runtimeRegistry;
  }
  async start(): Promise<void> {
    const workspaceRoot = `${this.config.dataDir}/projects`;
    const baseRoot = `${this.config.dataDir}/bases`;
    const workspaces = new WorkspaceManager(workspaceRoot, baseRoot, undefined, this.logger);

    for (const project of this.projects) {
      try {
        await workspaces.syncBase(project);
      } catch (error) {
        this.logger.error("failed to sync base repository", {
          projectId: project.id,
          error: (error as Error).message,
        });
      }

      const runtimeType = project.runtime?.type ?? this.defaultRuntime;
      this.logger.info("starting project runtime", {
        projectId: project.id,
        runtime: runtimeType,
      });
      const runtime = this.createRuntime(project, workspaces);
      this.runtimes.set(project.id, runtime);
      await runtime.start();
    }
    this.logger.info("project runtimes started", {
      projectCount: this.projects.length,
    });
  }
  async stop(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.stop()));
    this.logger.info("project runtimes stopped", {
      projectCount: this.runtimes.size,
    });
  }
  get(projectId: string): ProjectRuntime {
    let runtime = this.runtimes.get(projectId);
    if (!runtime && projectId === GLOBAL_PROJECT_ID) {
      runtime = this.createRuntime(this.globalProject);
      this.runtimes.set(GLOBAL_PROJECT_ID, runtime);
    }
    if (!runtime) {
      throw new NotFoundError(
        `project runtime not found: ${projectId}`,
        ErrorCode.PROJECT_NOT_FOUND,
      );
    }
    return runtime;
  }
  getGlobalProject(): ProjectConfig {
    return this.globalProject;
  }
  list(): ProjectConfig[] {
    return this.projects;
  }
  async listSkills(projectId: string): Promise<ProjectSkill[]> {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) {
      throw new NotFoundError(`project not found: ${projectId}`, ErrorCode.PROJECT_NOT_FOUND);
    }
    return SkillManager.listProjectSkills(project);
  }
  private createRuntime(
    project: ProjectConfig,
    sharedWorkspaces?: WorkspaceManager,
  ): ProjectRuntime {
    const runtimeType = project.runtime?.type ?? this.defaultRuntime;
    const effective: ProjectConfig = {
      ...project,
      runtime: { ...project.runtime, type: runtimeType },
      notifications: mergeNotifications(this.config.notifications ?? [], project.notifications),
    };
    const workspaceRoot = `${this.config.dataDir}/projects`;
    const baseRoot = `${this.config.dataDir}/bases`;
    const workspaces =
      sharedWorkspaces ?? new WorkspaceManager(workspaceRoot, baseRoot, undefined, this.logger);
    const artifacts = new ArtifactStore(this.config.artifactDir, this.store);

    const actionRegistry = new ActionRegistry(this.logger, this.store);
    if (project.id !== GLOBAL_PROJECT_ID) {
      actionRegistry.registerAll(defaultActionRegistry.list());
    }

    const createAgentRuntime = (type: string): AgentRuntime =>
      this.runtimeRegistry.create(type, {
        project: { ...effective, runtime: { ...effective.runtime, type } },
        logger: this.logger.child({ projectId: project.id }),
        config: this.config,
        actionRegistry,
        globalProject: project.id === GLOBAL_PROJECT_ID ? undefined : this.globalProject,
      });

    const runtime = createAgentRuntime(runtimeType);
    return new ProjectRuntime(
      effective,
      this.store,
      runtime,
      workspaces,
      artifacts,
      new NotificationOutbox(this.store, new NotificationHub(this.logger), this.logger),
      this.logger,
      this.eventHub,
      this.sessionManager,
      { runtimeFactory: createAgentRuntime, pipelineEventHub: this.pipelineEventHub },
      project.id === GLOBAL_PROJECT_ID ? undefined : this.globalProject,
      undefined,
      undefined,
      undefined,
      actionRegistry,
    );
  }
}

export function mergeNotifications(
  globalConfigs: NotificationConfig[] = [],
  projectConfigs?: NotificationConfig[],
): NotificationConfig[] {
  const merged = new Map<string, NotificationConfig>();
  for (const cfg of globalConfigs) {
    merged.set(cfg.name.toLowerCase(), cfg);
  }
  for (const cfg of projectConfigs ?? []) {
    merged.set(cfg.name.toLowerCase(), cfg);
  }
  return [...merged.values()];
}
