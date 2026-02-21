/**
 * pg-test.ts — PostgreSQL test helper for Vitest.
 *
 * Provides a shared pool factory and database cleanup utility.
 * Each test file creates a pool in beforeAll, resets the public schema in
 * beforeEach (store factories recreate schema via initSchema), and drains
 * the pool in afterAll.
 *
 * Connection: TEST_DATABASE_URL env var, or defaults to local docker-compose PG.
 */

import { createPool, type Pool } from "../../src/server/db.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://majel:majel@localhost:5432/majel";

/**
 * Create a connection pool for tests.
 * Uses TEST_DATABASE_URL or the local docker-compose default.
 */
export function createTestPool(): Pool {
  return createPool(TEST_DATABASE_URL);
}

/**
 * Reset the public schema completely.
 * This avoids expensive per-table loops while preserving strong isolation.
 */
export async function cleanDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
  `);
}

/**
 * Truncate all public schema tables and reset identities.
 * Use when schema is initialized once and tests only need data isolation.
 */
export async function truncatePublicTables(pool: Pool): Promise<void> {
  const result = await pool.query<{ tablename: string }>(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  `);

  if (result.rows.length === 0) return;

  const tableList = result.rows
    .map((row) => `"${row.tablename.replace(/"/g, '""')}"`)
    .join(", ");

  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

export type { Pool };
