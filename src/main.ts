import {
  configPathFromArgs,
  loadConfig,
  loadProjects,
  prepareDirectories,
} from "./config/config.ts";
import { MemoryStore, PostgresStore, type Store } from "./persistence/store.ts";
import { ProjectManager } from "./project/manager.ts";
import { Gateway } from "./gateway/server.ts";
import { Logger } from "./observability/logger.ts";
import { MemoryEventHub } from "./events/hub.ts";
import { SessionManager } from "./session/index.ts";

const config = await loadConfig(configPathFromArgs(process.argv.slice(2)));
const logger = new Logger({ level: config.logLevel });
logger.info("service bootstrap started", {
  host: config.host,
  port: config.port,
  database: config.databaseUrl ? "postgres" : "memory",
});
await prepareDirectories(config);
const projects = await loadProjects(config.projectConfigPath);
logger.info("project configuration loaded", { projectCount: projects.length });
let store: Store;
if (config.databaseUrl) store = PostgresStore.fromUrl(config.databaseUrl, projects);
else {
  const memory = new MemoryStore();
  for (const project of projects) memory.projects.set(project.id, project);
  store = memory;
}
await store.migrate();
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
const gateway = new Gateway(config, store, projectManager, logger, eventHub, sessionManager);
await gateway.start();
const server = gateway.listen();
logger.info("gateway listening", { host: config.host, port: config.port });
const shutdown = async () => {
  logger.info("service shutdown started");
  await gateway.stop();
  server.stop(true);
  await projectManager.stop();
  await store.close();
  logger.info("service shutdown completed");
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
