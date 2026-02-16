/**
 * db.ts — PostgreSQL connection layer (ADR-018 Phase 3, #39 dual-pool)
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Dual-pool pattern:
 *   - Admin pool (superuser) — used ONLY for schema migrations (initSchema).
 *   - App pool (non-superuser) — used for all runtime queries.
 *     RLS is enforced because the role is NOSUPERUSER.
 *
 * Pattern:
 *   const adminPool = createPool(adminUrl);    // DDL only
 *   const appPool   = createPool(appUrl);      // all store queries
 *   const store = await createSettingsStore(adminPool, appPool);
 *   // store.initSchema runs on adminPool, queries use appPool
 *   await adminPool.end();
 *   await appPool.end();
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
  const pool = new Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 5000,  // fail after 5s if no connection available
    idleTimeoutMillis: 30000,       // release idle clients after 30s
  });

  // Must handle pool error events — unhandled idle-client errors crash the process
  pool.on("error", (err) => {
    console.error("[pg pool] idle client error:", err.message);
  });

  return pool;
}

/**
 * Ensure the `majel_app` non-superuser role exists (#39).
 *
 * Must be called with the admin (superuser) pool before creating the app pool.
 * Idempotent — safe to call on every boot. Grants:
 *   - CONNECT on the database
 *   - USAGE on schema public
 *   - SELECT/INSERT/UPDATE/DELETE on all current + future tables
 *   - USAGE/SELECT on all current + future sequences
 */
export async function ensureAppRole(adminPool: Pool): Promise<void> {
  await adminPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'majel_app') THEN
        CREATE ROLE majel_app LOGIN PASSWORD 'majel_app'
          NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF;
    END $$;
  `);

  // Extract current database name for GRANT CONNECT
  const dbResult = await adminPool.query("SELECT current_database()");
  const dbName = dbResult.rows[0].current_database;

  await adminPool.query(`GRANT CONNECT ON DATABASE ${dbName} TO majel_app`);
  await adminPool.query("GRANT USAGE ON SCHEMA public TO majel_app");

  // Grant on existing tables + sequences
  await adminPool.query(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO majel_app",
  );
  await adminPool.query(
    "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO majel_app",
  );

  // Auto-grant on future tables/sequences created by the current superuser
  await adminPool.query(`
    ALTER DEFAULT PRIVILEGES
    IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO majel_app
  `);
  await adminPool.query(`
    ALTER DEFAULT PRIVILEGES
    IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO majel_app
  `);
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
