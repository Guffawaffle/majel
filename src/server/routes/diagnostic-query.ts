/**
 * routes/diagnostic-query.ts — AI-Consumable DB Query Tool
 *
 * Safe, read-only SQL query endpoint designed for AI consumption.
 * Uses the shared PostgreSQL pool for all queries.
 *
 * Safety: Only SELECT, EXPLAIN, and WITH statements are allowed.
 * Row limit enforced (default 100, max 1000).
 *
 * Migrated to PostgreSQL in ADR-018 Phase 3.
 */

import { Router } from "express";
import type { Pool } from "../db.js";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireAdmiral } from "../services/auth.js";
import { log } from "../logger.js";

// ─── Safety ─────────────────────────────────────────────────

const MAX_ROWS = 1000;
const DEFAULT_ROWS = 100;

/** Only these statement types are allowed. */
const ALLOWED_PREFIXES = ["select", "explain", "with"];

/** Statements that must NOT appear after a WITH prefix (writable CTEs). */
const DANGEROUS_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i;

function isSafeQuery(sql: string): { safe: boolean; reason?: string } {
  const trimmed = sql.trim();

  // Reject multi-statement queries (semicolons not at the very end)
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    return { safe: false, reason: "Multi-statement queries are not allowed" };
  }

  const lower = trimmed.toLowerCase();

  // Must start with an allowed prefix
  if (!ALLOWED_PREFIXES.some((p) => lower.startsWith(p))) {
    return { safe: false, reason: `Only SELECT, EXPLAIN, and WITH statements are allowed. Got: "${trimmed.split(/\s/)[0]}"` };
  }

  // WITH (CTE) queries must not contain writable operations
  if (lower.startsWith("with") && DANGEROUS_KEYWORDS.test(lower)) {
    const match = lower.match(DANGEROUS_KEYWORDS);
    return { safe: false, reason: `Writable CTE operations are not allowed: "${match?.[0]}"` };
  }

  return { safe: true };
}

// ─── Route Factory ──────────────────────────────────────────

export function createDiagnosticQueryRoutes(appState: AppState): Router {
  const router = Router();
  router.use("/api/diagnostic", requireAdmiral(appState));

  /**
   * Get the pool from app state.
   * Returns null if pool isn't available.
   */
  function getPool(): Pool | null {
    return appState.pool ?? null;
  }

  // ─── Schema Introspection ─────────────────────────────────

  /**
   * GET /api/diagnostic/schema
   * Lists all tables, their columns, and row counts.
   * Designed for AI bootstrap — call this first to understand the data model.
   */
  router.get("/api/diagnostic/schema", async (_req, res) => {
    const pool = getPool();
    if (!pool) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Database pool not available", 503);
    }

    try {
      // List user tables (exclude PG internal tables)
      const tablesRes = await pool.query(
        `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );
      const tables = tablesRes.rows as { name: string }[];

      const schema = [];
      for (const t of tables) {
        // Column info from information_schema
        const columnsRes = await pool.query(
          `SELECT column_name, data_type, is_nullable, column_default, 
            (SELECT EXISTS (
              SELECT 1 FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
              WHERE tc.table_name = $1 AND kcu.column_name = c.column_name AND tc.constraint_type = 'PRIMARY KEY'
            )) AS is_pk
           FROM information_schema.columns c
           WHERE table_schema = 'public' AND table_name = $1
           ORDER BY ordinal_position`,
          [t.name],
        );
        const columns = columnsRes.rows as {
          column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_pk: boolean;
        }[];

        const countRes = await pool.query(`SELECT COUNT(*) AS count FROM "${t.name}"`);
        const count = Number((countRes.rows[0] as { count: string | number }).count);

        // Index info from pg_indexes
        const indexesRes = await pool.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
          [t.name],
        );
        const indexes = indexesRes.rows as { indexname: string; indexdef: string }[];

        schema.push({
          table: t.name,
          rowCount: count,
          columns: columns.map((c) => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable === "YES",
            defaultValue: c.column_default,
            primaryKey: c.is_pk,
          })),
          indexes: indexes.map((i) => ({
            name: i.indexname,
            unique: i.indexdef.includes("UNIQUE"),
          })),
        });
      }

      sendOk(res, {
        database: "postgresql",
        tables: schema,
        hint: "Use GET /api/diagnostic/query?sql=SELECT ... to run read-only queries. Max 1000 rows.",
      });
    } catch (err) {
      log.boot.warn({ err: err instanceof Error ? err.message : String(err) }, "schema introspection error");
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Schema introspection failed", 500);
    }
  });

  // ─── Query Execution ──────────────────────────────────────

  /**
   * GET /api/diagnostic/query?sql=SELECT ...&limit=100
   * Execute a read-only SQL query against the database.
   *
   * Query params:
   *   sql   — The SQL statement (required). Must be SELECT, EXPLAIN, or WITH.
   *   limit — Max rows to return (default 100, max 1000).
   *
   * Response shape (designed for AI consumption):
   *   { columns: string[], rows: object[], rowCount: number, truncated: boolean, durationMs: number }
   */
  router.get("/api/diagnostic/query", async (req, res) => {
    const sql = req.query.sql as string | undefined;
    if (!sql) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required query param: sql", 400);
    }
    if (sql.length > 10000) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "SQL query must be 10,000 characters or fewer", 400);
    }

    const safety = isSafeQuery(sql);
    if (!safety.safe) {
      return sendFail(res, ErrorCode.INVALID_PARAM, safety.reason!, 400);
    }

    const limit = Math.min(
      Math.max(1, parseInt(req.query.limit as string, 10) || DEFAULT_ROWS),
      MAX_ROWS,
    );

    const pool = getPool();
    if (!pool) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Database pool not available", 503);
    }

    try {
      const start = performance.now();

      // Belt-and-suspenders: execute inside a read-only transaction
      // so even if isSafeQuery misses something, PostgreSQL rejects writes.
      const client = await pool.connect();
      let result;
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        result = await client.query(sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const allRows = result.rows as Record<string, unknown>[];
      const truncated = allRows.length > limit;
      const rows = allRows.slice(0, limit);
      const columns = result.fields.map((f) => f.name);

      const durationMs = Math.round((performance.now() - start) * 100) / 100;

      sendOk(res, {
        columns,
        rows,
        rowCount: rows.length,
        totalBeforeLimit: allRows.length,
        truncated,
        limit,
        durationMs,
        sql,
      });
    } catch (err) {
      log.boot.warn({ err: err instanceof Error ? err.message : String(err) }, "diagnostic query error");
      sendFail(res, ErrorCode.INVALID_PARAM, "Query execution failed", 400);
    }
  });

  // ─── Canned Queries (AI Quick Access) ─────────────────────

  /**
   * GET /api/diagnostic/summary
   * Pre-built summary of reference + overlay data for AI consumption.
   * No SQL knowledge required — just call this for a quick health check.
   */
  router.get("/api/diagnostic/summary", async (_req, res) => {
    const pool = getPool();
    if (!pool) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Database pool not available", 503);
    }

    try {
      const officerCountRes = await pool.query(`SELECT COUNT(*) AS c FROM reference_officers`);
      const officerCount = Number((officerCountRes.rows[0] as { c: string | number }).c);
      const shipCountRes = await pool.query(`SELECT COUNT(*) AS c FROM reference_ships`);
      const shipCount = Number((shipCountRes.rows[0] as { c: string | number }).c);

      const officersByRarityRes = await pool.query(
        `SELECT rarity, COUNT(*) AS count FROM reference_officers GROUP BY rarity ORDER BY count DESC`,
      );
      const officersByRarity = officersByRarityRes.rows as { rarity: string | null; count: string | number }[];

      const shipsByClassRes = await pool.query(
        `SELECT ship_class, COUNT(*) AS count FROM reference_ships GROUP BY ship_class ORDER BY count DESC`,
      );
      const shipsByClass = shipsByClassRes.rows as { ship_class: string | null; count: string | number }[];

      const shipsByFactionRes = await pool.query(
        `SELECT faction, COUNT(*) AS count FROM reference_ships GROUP BY faction ORDER BY count DESC`,
      );
      const shipsByFaction = shipsByFactionRes.rows as { faction: string | null; count: string | number }[];

      // Overlay stats (may be empty if tables don't exist yet)
      let officerOverlayCount = 0;
      let shipOverlayCount = 0;
      let officerOwnershipBreakdown: { ownership_state: string; count: string | number }[] = [];
      let shipOwnershipBreakdown: { ownership_state: string; count: string | number }[] = [];

      try {
        const oocRes = await pool.query(`SELECT COUNT(*) AS c FROM officer_overlay`);
        officerOverlayCount = Number((oocRes.rows[0] as { c: string | number }).c);
        const socRes = await pool.query(`SELECT COUNT(*) AS c FROM ship_overlay`);
        shipOverlayCount = Number((socRes.rows[0] as { c: string | number }).c);
        const oobRes = await pool.query(`SELECT ownership_state, COUNT(*) AS count FROM officer_overlay GROUP BY ownership_state`);
        officerOwnershipBreakdown = oobRes.rows as { ownership_state: string; count: string | number }[];
        const sobRes = await pool.query(`SELECT ownership_state, COUNT(*) AS count FROM ship_overlay GROUP BY ownership_state`);
        shipOwnershipBreakdown = sobRes.rows as { ownership_state: string; count: string | number }[];
      } catch {
        // Overlay tables may not exist yet
      }

      const sampleOfficersRes = await pool.query(
        `SELECT id, name, rarity, group_name AS "groupName" FROM reference_officers ORDER BY name LIMIT 5`,
      );
      const sampleShipsRes = await pool.query(
        `SELECT id, name, ship_class AS "shipClass", rarity, faction FROM reference_ships ORDER BY name LIMIT 5`,
      );

      sendOk(res, {
        reference: {
          officers: { total: officerCount, byRarity: officersByRarity },
          ships: { total: shipCount, byClass: shipsByClass, byFaction: shipsByFaction },
        },
        overlay: {
          officers: { total: officerOverlayCount, byOwnership: officerOwnershipBreakdown },
          ships: { total: shipOverlayCount, byOwnership: shipOwnershipBreakdown },
        },
        samples: {
          officers: sampleOfficersRes.rows,
          ships: sampleShipsRes.rows,
        },
        hint: "Use /api/diagnostic/schema for full table structure, /api/diagnostic/query?sql=... for custom queries.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INTERNAL_ERROR, `Summary failed: ${message}`, 500);
    }
  });

  return router;
}
