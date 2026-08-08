import { Pool, type PoolClient } from "pg";
import {
  ADDITIVE_SCHEMA_MIGRATIONS,
  SCHEMA_STATEMENTS,
} from "@/lib/db/schema";

export class DatabaseConfigurationError extends Error {
  constructor(message = "尚未配置 DATABASE_URL。") {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

declare global {
  var hyperScopeDatabasePool: Pool | undefined;
  var hyperScopeSchemaPromise: Promise<void> | undefined;
}

export function getDatabasePool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new DatabaseConfigurationError();

  if (!globalThis.hyperScopeDatabasePool) {
    const pool = new Pool({
      connectionString,
      application_name: "hyperscope",
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (error) => {
      console.error("Unexpected PostgreSQL pool error", error);
    });
    globalThis.hyperScopeDatabasePool = pool;
  }

  return globalThis.hyperScopeDatabasePool;
}

export async function ensureSchema() {
  if (!globalThis.hyperScopeSchemaPromise) {
    globalThis.hyperScopeSchemaPromise = (async () => {
      const pool = getDatabasePool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(84519320)");
        for (const statement of SCHEMA_STATEMENTS) {
          await client.query(statement);
        }
        for (const statement of ADDITIVE_SCHEMA_MIGRATIONS) {
          await client.query(statement);
        }

        const migration = await client.query(
          `
            INSERT INTO schema_migrations (id)
            VALUES ('positions-primary-key-v2')
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          `,
        );
        if ((migration.rowCount ?? 0) > 0) {
          await client.query("ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_pkey");
          await client.query(
            "ALTER TABLE positions ADD CONSTRAINT positions_pkey PRIMARY KEY (address_id, dex, coin)",
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      globalThis.hyperScopeSchemaPromise = undefined;
      throw error;
    });
  }

  return globalThis.hyperScopeSchemaPromise;
}

export async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await ensureSchema();
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  if (globalThis.hyperScopeDatabasePool) {
    await globalThis.hyperScopeDatabasePool.end();
    globalThis.hyperScopeDatabasePool = undefined;
    globalThis.hyperScopeSchemaPromise = undefined;
  }
}
