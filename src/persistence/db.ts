import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { schema } from "./schema.ts";

export type DrizzleDatabase = NodePgDatabase<typeof schema>;
export type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
export type DrizzleExecutor = DrizzleDatabase | DrizzleTransaction;

/** Creates a typed Drizzle ORM database instance over an existing `pg.Pool` or `PoolClient`. */
export function createDrizzleDb(client: Pool | PoolClient): DrizzleDatabase {
  return drizzle(client, { schema });
}
