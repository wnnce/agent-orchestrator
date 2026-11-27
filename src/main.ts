import {
  configPathFromArgs,
  loadConfig,
  loadProjects,
  prepareDirectories,
} from "./config/config.ts";
import { MemoryStore, PostgresStore, type Store } from "./persistence/store.ts";
import { ProjectManager } from "./project/manager.ts";
import { createAppServices } from "./app/index.ts";
import { createChannels } from "./channels/index.ts";
import { Gateway } from "./gateway/server.ts";
import { Logger } from "./observability/logger.ts";
import { setupTracing } from "./observability/tracing-setup.ts";
import { MemoryEventHub } from "./events/hub.ts";
import { SessionManager } from "./session/index.ts";

const config = await loadConfig(configPathFromArgs(process.argv.slice(2)));
const logger = new Logger({ level: config.logLevel });
const tracing = setupTracing(config.tracing, { logger });
logger.info("service bootstrap started", {
  host: config.host,
  port: config.port,
  database: config.databaseUrl ? "postgres" : "memory",
});
await prepareDirectories(config);
const projects = await loadProjects(config.projectConfigPath);
logger.info("project configuration loaded", { projectCount: projects.length });
let store: Store;
if (config.databaseUrl) store = PostgresStore.fromUrl(config.databaseUrl);
else store = new MemoryStore();
const sessionManager = new SessionManager(store);
const eventHub = new MemoryEventHub(store, sessionManager);
const projectManager = new ProjectManager(
  projects,
  store,
  config,
  logger,
  eventHub,
  sessionManager,
);
await projectManager.start();
const channels = createChannels(config, { eventHub, sessionManager, logger });
const { sessions, inbound } = createAppServices({
  config,
  store,
  projects: projectManager,
  logger,
  channels,
});
const gateway = new Gateway({ config, logger, store, projects: projectManager, sessions, inbound });
const server = gateway.listen();
logger.info("gateway listening", { host: config.host, port: config.port });
for (const channel of channels) await channel.start((envelope) => inbound.accept(envelope));

const shutdown = async () => {
  logger.info("service shutdown started");
  server.stop(true);
  // Draining the inbox may still stream replies, so channels stop after it.
  await inbound.stop();
  await Promise.all(channels.map((channel) => channel.stop()));
  await projectManager.stop();
  await store.close();
  await tracing.shutdown();
  logger.info("service shutdown completed");
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
