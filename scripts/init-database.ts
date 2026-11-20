import { readFile } from "node:fs/promises";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import YAML from "yaml";
import { createDrizzleDb } from "../src/persistence/db.ts";

function configPathFromArgs(args: string[]): string {
  if (args.length === 0) return "config.yaml";
  if (args.length === 1 && args[0]?.startsWith("--config=")) {
    const value = args[0].slice("--config=".length).trim();
    if (value) return value;
  }
  if (args.length === 2 && (args[0] === "--config" || args[0] === "-c") && args[1]) {
    return args[1];
  }
  throw new Error("Usage: bun run db:init [--config <path>]");
}

function readDatabaseUrl(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const config = raw as Record<string, unknown>;
  const storage =
    config.storage && typeof config.storage === "object" && !Array.isArray(config.storage)
      ? (config.storage as Record<string, unknown>)
      : undefined;
  const value = storage?.databaseUrl ?? config.databaseUrl;
  return typeof value === "string" ? value.trim() : "";
}

const configPath = path.resolve(configPathFromArgs(process.argv.slice(2)));
const configSource = await readFile(configPath, "utf8");
const document = YAML.parseDocument(configSource);
if (document.errors.length > 0) {
  throw new Error(`Invalid service YAML: ${configPath} (${document.errors[0]?.code})`);
}

const databaseUrl = readDatabaseUrl(document.toJSON());
if (!databaseUrl) {
  throw new Error(`PostgreSQL databaseUrl is not configured in ${configPath}`);
}

const migrationsFolder = path.resolve(import.meta.dir, "../database/migrations");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const db = createDrizzleDb(pool);
  await migrate(db, { migrationsFolder });
  console.log(`Database migrations applied from ${migrationsFolder}`);
} finally {
  await pool.end();
}
