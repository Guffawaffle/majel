/**
 * db.ts — PostgreSQL connection layer (ADR-018 Phase 3)
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Pool-based wrapper around `pg`. All stores share a single Pool
 * created at boot time and passed to each store factory.
 *
 * Pattern:
 *   const pool = createPool();
 *   const store = await createSettingsStore(pool);
 *   // ...
 *   await pool.end();
 */

import pg from "pg";
const { Pool } = pg;
type Pool = pg.Pool;
type PoolClient = pg.PoolClient;
type QueryResult = pg.QueryResult;

export type { Pool, PoolClient, QueryResult };

/**
 * Create a connection pool.
 *
 * @param connectionString — Postgres URL. Falls back to DATABASE_URL env var,
 *                           then to local dev default.
 */
export function createPool(connectionString?: string): Pool {
  const url =
    connectionString ||
    process.env.DATABASE_URL ||
    "postgres://majel:majel@localhost:5432/majel";

  // max: 5 — Cloud SQL db-f1-micro supports ~25 connections.
  // With Cloud Run max-instances=3, this caps at 15 (safe headroom). (ADR-023)
  return new Pool({ connectionString: url, max: 5 });
}

/**
 * Run a sequence of DDL statements inside a single transaction.
 * Used by stores during schema initialization.
 */
export async function initSchema(
  pool: Pool,
  statements: string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const stmt of statements) {
      await client.query(stmt);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Execute a callback inside a transaction.
 * Commits on success, rolls back on error.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
