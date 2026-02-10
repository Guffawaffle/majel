/**
 * routes/diagnostic-query.ts — AI-Consumable DB Query Tool
 *
 * Safe, read-only SQL query endpoint designed for AI consumption.
 * Opens a separate connection to reference.db via @libsql/client.
 *
 * Safety: Only SELECT, PRAGMA, and EXPLAIN statements are allowed.
 * Row limit enforced (default 100, max 1000).
 *
 * Migrated from better-sqlite3 to @libsql/client in ADR-018 Phase 1.
 */

import { Router } from "express";
import { openDatabase, type Client } from "../db.js";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireAdmiral } from "../auth.js";

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
  router.use("/api/diagnostic", requireAdmiral(appState));

  /**
   * Get a client to the reference DB.
   * Returns null if reference store isn't available.
   */
  function getClient(): Client | null {
    if (!appState.referenceStore) return null;
    const dbPath = appState.referenceStore.getDbPath();
    return openDatabase(dbPath);
  }

  // ─── Schema Introspection ─────────────────────────────────

  /**
   * GET /api/diagnostic/schema
   * Lists all tables, their columns, and row counts.
   * Designed for AI bootstrap — call this first to understand the data model.
   */
  router.get("/api/diagnostic/schema", async (_req, res) => {
    const client = getClient();
    if (!client) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }

    try {
      const tablesRes = await client.execute(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      );
      const tables = tablesRes.rows as unknown as { name: string }[];

      const schema = [];
      for (const t of tables) {
        const columnsRes = await client.execute(`PRAGMA table_info('${t.name}')`);
        const columns = columnsRes.rows as unknown as {
          cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
        }[];
        const countRes = await client.execute(`SELECT COUNT(*) AS count FROM "${t.name}"`);
        const count = (countRes.rows[0] as unknown as { count: number }).count;
        const indexesRes = await client.execute(`PRAGMA index_list('${t.name}')`);
        const indexes = indexesRes.rows as unknown as {
          seq: number; name: string; unique: number;
        }[];
        schema.push({
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
        });
      }

      sendOk(res, {
        dbPath: appState.referenceStore!.getDbPath(),
        tables: schema,
        hint: "Use GET /api/diagnostic/query?sql=SELECT ... to run read-only queries. Max 1000 rows.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INTERNAL_ERROR, `Schema introspection failed: ${message}`, 500);
    } finally {
      client.close();
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
  router.get("/api/diagnostic/query", async (req, res) => {
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

    const client = getClient();
    if (!client) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }

    try {
      const start = performance.now();
      const result = await client.execute(sql);

      if (result.rows.length > 0 || result.columns.length > 0) {
        // Reader query (SELECT-like)
        const allRows = result.rows as unknown as Record<string, unknown>[];
        const truncated = allRows.length > limit;
        const rows = allRows.slice(0, limit);
        const columns = result.columns.length > 0
          ? result.columns
          : (rows.length > 0 ? Object.keys(rows[0]) : []);

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
        const durationMs = Math.round((performance.now() - start) * 100) / 100;

        sendOk(res, {
          columns: [],
          rows: [],
          rowCount: 0,
          changes: result.rowsAffected,
          durationMs,
          sql,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, `SQL error: ${message}`, 400);
    } finally {
      client.close();
    }
  });

  // ─── Canned Queries (AI Quick Access) ─────────────────────

  /**
   * GET /api/diagnostic/summary
   * Pre-built summary of reference + overlay data for AI consumption.
   * No SQL knowledge required — just call this for a quick health check.
   */
  router.get("/api/diagnostic/summary", async (_req, res) => {
    const client = getClient();
    if (!client) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }

    try {
      const officerCountRes = await client.execute(`SELECT COUNT(*) AS c FROM reference_officers`);
      const officerCount = (officerCountRes.rows[0] as unknown as { c: number }).c;
      const shipCountRes = await client.execute(`SELECT COUNT(*) AS c FROM reference_ships`);
      const shipCount = (shipCountRes.rows[0] as unknown as { c: number }).c;

      const officersByRarityRes = await client.execute(
        `SELECT rarity, COUNT(*) AS count FROM reference_officers GROUP BY rarity ORDER BY count DESC`,
      );
      const officersByRarity = officersByRarityRes.rows as unknown as { rarity: string | null; count: number }[];

      const shipsByClassRes = await client.execute(
        `SELECT ship_class, COUNT(*) AS count FROM reference_ships GROUP BY ship_class ORDER BY count DESC`,
      );
      const shipsByClass = shipsByClassRes.rows as unknown as { ship_class: string | null; count: number }[];

      const shipsByFactionRes = await client.execute(
        `SELECT faction, COUNT(*) AS count FROM reference_ships GROUP BY faction ORDER BY count DESC`,
      );
      const shipsByFaction = shipsByFactionRes.rows as unknown as { faction: string | null; count: number }[];

      // Overlay stats (may be empty if tables don't exist yet)
      let officerOverlayCount = 0;
      let shipOverlayCount = 0;
      let officerOwnershipBreakdown: { ownership_state: string; count: number }[] = [];
      let shipOwnershipBreakdown: { ownership_state: string; count: number }[] = [];

      try {
        const oocRes = await client.execute(`SELECT COUNT(*) AS c FROM officer_overlay`);
        officerOverlayCount = (oocRes.rows[0] as unknown as { c: number }).c;
        const socRes = await client.execute(`SELECT COUNT(*) AS c FROM ship_overlay`);
        shipOverlayCount = (socRes.rows[0] as unknown as { c: number }).c;
        const oobRes = await client.execute(`SELECT ownership_state, COUNT(*) AS count FROM officer_overlay GROUP BY ownership_state`);
        officerOwnershipBreakdown = oobRes.rows as unknown as { ownership_state: string; count: number }[];
        const sobRes = await client.execute(`SELECT ownership_state, COUNT(*) AS count FROM ship_overlay GROUP BY ownership_state`);
        shipOwnershipBreakdown = sobRes.rows as unknown as { ownership_state: string; count: number }[];
      } catch {
        // Overlay tables may not exist yet
      }

      const sampleOfficersRes = await client.execute(
        `SELECT id, name, rarity, group_name AS groupName FROM reference_officers ORDER BY name LIMIT 5`,
      );
      const sampleShipsRes = await client.execute(
        `SELECT id, name, ship_class AS shipClass, rarity, faction FROM reference_ships ORDER BY name LIMIT 5`,
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
    } finally {
      client.close();
    }
  });

  return router;
}
