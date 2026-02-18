/**
 * db.test.ts — Database Connection Layer Tests
 *
 * Tests createPool fallback logic and initSchema error handling.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createPool, initSchema } from "../src/server/db.js";

describe("createPool", () => {
  const pools: ReturnType<typeof createPool>[] = [];

  afterEach(async () => {
    for (const p of pools) {
      await p.end().catch(() => {});
    }
    pools.length = 0;
  });

  it("creates a pool with an explicit connection string", () => {
    const pool = createPool("postgres://majel:majel@localhost:5432/majel");
    pools.push(pool);
    expect(pool).toBeDefined();
    expect(typeof pool.query).toBe("function");
  });

  it("creates a pool falling back to DATABASE_URL", () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://majel:majel@localhost:5432/majel";
    try {
      const pool = createPool();
      pools.push(pool);
      expect(pool).toBeDefined();
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });

  it("creates a pool falling back to default when no env var", () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const pool = createPool();
      pools.push(pool);
      expect(pool).toBeDefined();
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });
});

describe("initSchema", () => {
  it("runs statements in a transaction", async () => {
    const pool = createPool("postgres://majel:majel@localhost:5432/majel");
    try {
      // Create and immediately drop a temp table — tests the transaction path
      await initSchema(pool, [
        "CREATE TABLE IF NOT EXISTS _test_init_schema (id INT)",
        "DROP TABLE IF EXISTS _test_init_schema",
      ]);
    } finally {
      await pool.end();
    }
  });

  it("rolls back on error", async () => {
    const pool = createPool("postgres://majel:majel@localhost:5432/majel");
    try {
      await expect(
        initSchema(pool, [
          "CREATE TABLE IF NOT EXISTS _test_rollback (id INT)",
          "INVALID SQL STATEMENT",
        ])
      ).rejects.toThrow();

      // Table should not exist because of rollback
      const result = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_test_rollback')"
      );
      expect(result.rows[0].exists).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
