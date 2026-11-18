import type {
  McpServerConfig,
  NotificationConfig,
  ProjectConfig,
  ProjectRuntimeConfig,
} from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import {
  RuntimeRegistry,
  defaultRuntimeRegistry,
  type AgentRuntime,
} from "../runtime/index.ts";
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

export class ProjectManager {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  readonly eventHub: EventHub;
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
    const defaultRuntimeType =
      this.projects[0]?.runtime?.type ??
      this.projects[0]?.agent?.type ??
      "codex";
    this.globalProject = createGlobalProjectConfig(
      globalProjectsDir,
      defaultRuntimeType,
    );
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
        await workspaces.syncAllBases(project);
      } catch (error) {
        this.logger.error("failed to sync base repositories", {
          projectId: project.id,
          error: (error as Error).message,
        });
      }

      const runtimeType =
        project.runtime?.type ?? project.agent?.type ?? "codex";
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
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => runtime.stop()),
    );
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
    if (!runtime) throw new Error(`project runtime not found: ${projectId}`);
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
    if (!project) throw new Error(`project not found: ${projectId}`);
    return SkillManager.listProjectSkills(project);
  }
  private createRuntime(
    project: ProjectConfig,
    sharedWorkspaces?: WorkspaceManager,
  ): ProjectRuntime {
    const runtimeType = project.runtime?.type ?? project.agent?.type ?? "codex";
    const projectMcpServers = (project.agent?.mcpServers ??
      project.runtime?.mcpServers ??
      []) as McpServerConfig[];
    const runtimeConfigEntry = (this.config.runtimes?.[runtimeType] ??
      (runtimeType === "codex" ? this.config.codex : undefined)) as
      | { mcpServers?: McpServerConfig[] }
      | undefined;
    const mcpServers = mergeMcpServers(
      (runtimeConfigEntry?.mcpServers ??
        this.config.codex?.mcpServers ??
        []) as McpServerConfig[],
      projectMcpServers,
    );
    const model = project.agent?.model ?? project.runtime?.model;
    const reasoningEffort =
      project.agent?.reasoningEffort ?? project.runtime?.reasoningEffort;

    const runtimeConfig: ProjectRuntimeConfig = {
      ...project.runtime,
      type: runtimeType,
      approvalPolicy: project.runtime?.approvalPolicy ?? "never",
      sandbox: project.runtime?.sandbox ?? "danger-full-access",
      mcpServers,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(project.runtime?.idleTimeoutMs !== undefined
        ? { idleTimeoutMs: project.runtime.idleTimeoutMs }
        : {}),
      ...(project.runtime?.archiveTimeoutMs !== undefined
        ? { archiveTimeoutMs: project.runtime.archiveTimeoutMs }
        : {}),
    };

    const effectiveNotifications = mergeNotifications(
      this.config.notifications ?? [],
      project.notifications,
    );

    const effective: ProjectConfig = {
      ...project,
      runtime: runtimeConfig,
      notifications: effectiveNotifications,
    };
    const workspaceRoot = `${this.config.dataDir}/projects`;
    const baseRoot = `${this.config.dataDir}/bases`;
    const workspaces =
      sharedWorkspaces ??
      new WorkspaceManager(workspaceRoot, baseRoot, undefined, this.logger);
    const artifacts = new ArtifactStore(this.config.artifactDir, this.store);

    const actionRegistry = new ActionRegistry(this.logger, this.store);
    if (project.id !== GLOBAL_PROJECT_ID) {
      actionRegistry.registerAll(defaultActionRegistry.list());
    }

    const runtime = this.runtimeRegistry.create(runtimeType, {
      project: effective,
      logger: this.logger.child({ projectId: project.id }),
      config: this.config,
      actionRegistry,
      globalProject:
        project.id === GLOBAL_PROJECT_ID ? undefined : this.globalProject,
    });
    return new ProjectRuntime(
      effective,
      this.store,
      runtime,
      workspaces,
      artifacts,
      new NotificationOutbox(
        this.store,
        new NotificationHub(this.logger),
        this.logger,
      ),
      this.logger,
      this.eventHub,
      this.sessionManager,
      {},
      project.id === GLOBAL_PROJECT_ID ? undefined : this.globalProject,
      undefined,
      undefined,
      undefined,
      actionRegistry,
    );
  }
}

function mergeMcpServers(
  globalServers: McpServerConfig[],
  projectServers: McpServerConfig[],
): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  for (const server of globalServers) merged.set(server.name, server);
  for (const server of projectServers) merged.set(server.name, server);
  return [...merged.values()];
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
