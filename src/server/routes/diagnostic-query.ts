/**
 * routes/diagnostic-query.ts — AI-Consumable DB Query Tool
 *
 * Safe, read-only SQL query endpoint designed for AI consumption.
 * Opens a separate read-only connection to reference.db.
 *
 * Safety: Only SELECT, PRAGMA, and EXPLAIN statements are allowed.
 * Row limit enforced (default 100, max 1000).
 */

import { Router } from "express";
import Database from "better-sqlite3";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";

// ─── Safety ─────────────────────────────────────────────────

const MAX_ROWS = 1000;
const DEFAULT_ROWS = 100;

/** Only these statement types are allowed. */
const ALLOWED_PREFIXES = ["select", "pragma", "explain", "with"];

function isSafeQuery(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  return ALLOWED_PREFIXES.some((p) => trimmed.startsWith(p));
}

// ─── Route Factory ──────────────────────────────────────────

export function createDiagnosticQueryRoutes(appState: AppState): Router {
  const router = Router();

  /**
   * Lazily open a read-only DB connection using the same path as referenceStore.
   * Returns null if reference store isn't available.
   */
  function getReadonlyDb(): Database.Database | null {
    if (!appState.referenceStore) return null;
    const dbPath = appState.referenceStore.getDbPath();
    return new Database(dbPath, { readonly: true });
  }

  // ─── Schema Introspection ─────────────────────────────────

  /**
   * GET /api/diagnostic/schema
   * Lists all tables, their columns, and row counts.
   * Designed for AI bootstrap — call this first to understand the data model.
   */
  router.get("/api/diagnostic/schema", (_req, res) => {
    const db = getReadonlyDb();
    if (!db) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }

    try {
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      ).all() as { name: string }[];

      const schema = tables.map((t) => {
        const columns = db.prepare(`PRAGMA table_info('${t.name}')`).all() as {
          cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
        }[];
        const count = (db.prepare(`SELECT COUNT(*) AS count FROM "${t.name}"`).get() as { count: number }).count;
        const indexes = db.prepare(`PRAGMA index_list('${t.name}')`).all() as {
          seq: number; name: string; unique: number;
        }[];
        return {
          table: t.name,
          rowCount: count,
          columns: columns.map((c) => ({
            name: c.name,
            type: c.type,
            nullable: !c.notnull,
            defaultValue: c.dflt_value,
            primaryKey: !!c.pk,
          })),
          indexes: indexes.map((i) => ({ name: i.name, unique: !!i.unique })),
        };
      });

      sendOk(res, {
        dbPath: appState.referenceStore!.getDbPath(),
        tables: schema,
        hint: "Use GET /api/diagnostic/query?sql=SELECT ... to run read-only queries. Max 1000 rows.",
      });
    } finally {
      db.close();
    }
  });

  // ─── Query Execution ──────────────────────────────────────

  /**
   * GET /api/diagnostic/query?sql=SELECT ...&limit=100
   * Execute a read-only SQL query against reference.db.
   *
   * Query params:
   *   sql   — The SQL statement (required). Must be SELECT, PRAGMA, EXPLAIN, or WITH.
   *   limit — Max rows to return (default 100, max 1000).
   *
   * Response shape (designed for AI consumption):
   *   { columns: string[], rows: object[], rowCount: number, truncated: boolean, durationMs: number }
   */
  router.get("/api/diagnostic/query", (req, res) => {
    const sql = req.query.sql as string | undefined;
    if (!sql) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required query param: sql", 400);
    }

    if (!isSafeQuery(sql)) {
      return sendFail(
        res,
        ErrorCode.INVALID_PARAM,
        `Only SELECT, PRAGMA, EXPLAIN, and WITH statements are allowed. Got: "${sql.trim().split(/\s/)[0]}"`,
        400,
      );
    }

    const limit = Math.min(
      Math.max(1, parseInt(req.query.limit as string, 10) || DEFAULT_ROWS),
      MAX_ROWS,
    );

    const db = getReadonlyDb();
    if (!db) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }

    try {
      const start = performance.now();
      const stmt = db.prepare(sql);

      // Check if statement returns data (SELECT-like) vs no data (some PRAGMAs)
      let rows: Record<string, unknown>[];
      let columns: string[];

      if (stmt.reader) {
        const allRows = stmt.all() as Record<string, unknown>[];
        const truncated = allRows.length > limit;
        rows = allRows.slice(0, limit);
        columns = rows.length > 0 ? Object.keys(rows[0]) : (stmt.columns().map((c) => c.name));

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
      } else {
        // Non-reader statement (some PRAGMAs return nothing)
        const result = stmt.run();
        const durationMs = Math.round((performance.now() - start) * 100) / 100;

        sendOk(res, {
          columns: [],
          rows: [],
          rowCount: 0,
          changes: result.changes,
          durationMs,
          sql,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, `SQL error: ${message}`, 400);
    } finally {
      db.close();
    }
  });

  // ─── Canned Queries (AI Quick Access) ─────────────────────

  /**
   * GET /api/diagnostic/summary
   * Pre-built summary of reference + overlay data for AI consumption.
   * No SQL knowledge required — just call this for a quick health check.
   */
  router.get("/api/diagnostic/summary", (_req, res) => {
    const db = getReadonlyDb();
    if (!db) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }

    try {
      const officerCount = (db.prepare(`SELECT COUNT(*) AS c FROM reference_officers`).get() as { c: number }).c;
      const shipCount = (db.prepare(`SELECT COUNT(*) AS c FROM reference_ships`).get() as { c: number }).c;

      const officersByRarity = db.prepare(
        `SELECT rarity, COUNT(*) AS count FROM reference_officers GROUP BY rarity ORDER BY count DESC`
      ).all() as { rarity: string | null; count: number }[];

      const shipsByClass = db.prepare(
        `SELECT ship_class, COUNT(*) AS count FROM reference_ships GROUP BY ship_class ORDER BY count DESC`
      ).all() as { ship_class: string | null; count: number }[];

      const shipsByFaction = db.prepare(
        `SELECT faction, COUNT(*) AS count FROM reference_ships GROUP BY faction ORDER BY count DESC`
      ).all() as { faction: string | null; count: number }[];

      // Overlay stats (may be empty)
      const officerOverlayCount = (db.prepare(`SELECT COUNT(*) AS c FROM officer_overlay`).get() as { c: number }).c;
      const shipOverlayCount = (db.prepare(`SELECT COUNT(*) AS c FROM ship_overlay`).get() as { c: number }).c;

      const officerOwnershipBreakdown = db.prepare(
        `SELECT ownership_state, COUNT(*) AS count FROM officer_overlay GROUP BY ownership_state`
      ).all() as { ownership_state: string; count: number }[];

      const shipOwnershipBreakdown = db.prepare(
        `SELECT ownership_state, COUNT(*) AS count FROM ship_overlay GROUP BY ownership_state`
      ).all() as { ownership_state: string; count: number }[];

      // Sample data (first 5 officers and ships)
      const sampleOfficers = db.prepare(
        `SELECT id, name, rarity, group_name AS groupName FROM reference_officers ORDER BY name LIMIT 5`
      ).all();

      const sampleShips = db.prepare(
        `SELECT id, name, ship_class AS shipClass, rarity, faction FROM reference_ships ORDER BY name LIMIT 5`
      ).all();

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
          officers: sampleOfficers,
          ships: sampleShips,
        },
        hint: "Use /api/diagnostic/schema for full table structure, /api/diagnostic/query?sql=... for custom queries.",
      });
    } finally {
      db.close();
    }
  });

  return router;
}
