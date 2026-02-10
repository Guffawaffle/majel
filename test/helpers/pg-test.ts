/**
 * pg-test.ts — PostgreSQL test helper for Vitest.
 *
 * Provides a shared pool factory and database cleanup utility.
 * Each test file creates a pool in beforeAll, drops all tables in
 * beforeEach (store factories recreate via initSchema), and drains
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
 * Drop every table in the public schema (CASCADE).
 * Store factories will recreate them via initSchema.
 */
export async function cleanDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

export type { Pool };
