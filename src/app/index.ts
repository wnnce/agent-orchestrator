import type { ChannelHooks } from "../channels/types.ts";
import type { AppConfig } from "../config/config.ts";
import type { Logger } from "../observability/logger.ts";
import type { Store } from "../persistence/store.ts";
import type { ProjectManager } from "../project/manager.ts";
import { ProjectRouter } from "../router/project-router.ts";
import { InboundService } from "./inbound.ts";
import { SessionService } from "./sessions.ts";
import { SessionTitleGenerator } from "./titles.ts";

export interface AppServices {
  readonly sessions: SessionService;
  readonly inbound: InboundService;
}

export interface AppServicesDeps {
  readonly config: AppConfig;
  readonly store: Store;
  readonly projects: ProjectManager;
  readonly logger: Logger;
  /** Chat channels that take part in handling their inbound messages. */
  readonly channels?: readonly ChannelHooks[] | undefined;
}

/** The services every external entry point (HTTP, webhooks, chats) works through. */
export function createAppServices(deps: AppServicesDeps): AppServices {
  const { config, store, projects, logger } = deps;
  const sessions = new SessionService({
    projects,
    router: new ProjectRouter(
      config.routerApiKey,
      config.routerModel,
      config.routerBaseUrl,
      logger,
    ),
    titles: new SessionTitleGenerator(config.titles, logger),
    logger,
  });
  const inbound = new InboundService({
    store,
    projects,
    sessions,
    channels: deps.channels ?? [],
    logger,
  });
  return { sessions, inbound };
}
