import { createAppServices } from "../../src/app/index.ts";
import type { AppConfig } from "../../src/config/config.ts";
import { Gateway } from "../../src/gateway/server.ts";
import type { Logger } from "../../src/observability/logger.ts";
import type { Store } from "../../src/persistence/store.ts";
import type { ProjectManager } from "../../src/project/manager.ts";

/** A gateway wired the way `src/main.ts` wires it, without chat channels. */
export function createGateway(
  config: AppConfig,
  store: Store,
  projects: ProjectManager,
  logger: Logger,
): Gateway {
  const { sessions, inbound } = createAppServices({ config, store, projects, logger });
  return new Gateway({ config, logger, store, projects, sessions, inbound });
}
