/**
 * receipt-store.ts — ADR-026 Import Receipt Data Layer
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Tracks every import/commit as a receipt with changeset, inverse (for undo),
 * and unresolved items (for ADR-026a A4 "continue resolving later").
 *
 * Pattern: factory function createReceiptStore(adminPool, appPool) → ReceiptStore.
 */

import { initSchema, type Pool } from "../db.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type ReceiptSourceType =
  | "catalog_clicks"
  | "guided_setup"
  | "file_import"
  | "community_export"
  | "sandbox"
  | "auto_seed";

export type ReceiptLayer = "reference" | "ownership" | "composition";

export interface ImportReceipt {
  id: number;
  sourceType: ReceiptSourceType;
  sourceMeta: Record<string, unknown>;
  mapping: Record<string, unknown> | null;
  layer: ReceiptLayer;
  changeset: { added?: unknown[]; updated?: unknown[]; removed?: unknown[] };
  inverse: { added?: unknown[]; updated?: unknown[]; removed?: unknown[] };
  unresolved: unknown[] | null;
  createdAt: string;
}

export interface CreateReceiptInput {
  sourceType: ReceiptSourceType;
  sourceMeta?: Record<string, unknown>;
  mapping?: Record<string, unknown> | null;
  layer: ReceiptLayer;
  changeset?: { added?: unknown[]; updated?: unknown[]; removed?: unknown[] };
  inverse?: { added?: unknown[]; updated?: unknown[]; removed?: unknown[] };
  unresolved?: unknown[] | null;
}

// ═══════════════════════════════════════════════════════════
// Store Interface
// ═══════════════════════════════════════════════════════════

export interface ReceiptStore {
  createReceipt(input: CreateReceiptInput): Promise<ImportReceipt>;
  listReceipts(limit?: number, layer?: ReceiptLayer): Promise<ImportReceipt[]>;
  getReceipt(id: number): Promise<ImportReceipt | null>;
  undoReceipt(id: number): Promise<{ success: boolean; message: string; inverse?: ImportReceipt["inverse"] }>;
  resolveReceiptItems(id: number, resolvedItems: unknown[]): Promise<ImportReceipt>;
  counts(): Promise<{ total: number }>;
  close(): void;
}

// ═══════════════════════════════════════════════════════════
// Schema DDL
// ═══════════════════════════════════════════════════════════

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS import_receipts (
    id SERIAL PRIMARY KEY,
    source_type TEXT NOT NULL
      CHECK (source_type IN ('catalog_clicks', 'guided_setup', 'file_import', 'community_export', 'sandbox', 'auto_seed')),
    source_meta JSONB NOT NULL DEFAULT '{}',
    mapping JSONB,
    layer TEXT NOT NULL
      CHECK (layer IN ('reference', 'ownership', 'composition')),
    changeset JSONB NOT NULL DEFAULT '{}',
    inverse JSONB NOT NULL DEFAULT '{}',
    unresolved JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_source ON import_receipts(source_type)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_layer ON import_receipts(layer)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_created ON import_receipts(created_at DESC)`,
];

// ═══════════════════════════════════════════════════════════
// SQL Fragments
// ═══════════════════════════════════════════════════════════

const RECEIPT_COLS = `id, source_type AS "sourceType", source_meta AS "sourceMeta",
  mapping, layer, changeset, inverse, unresolved, created_at AS "createdAt"`;

// ═══════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════

export async function createReceiptStore(adminPool: Pool, runtimePool?: Pool): Promise<ReceiptStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  log.boot.debug("receipt store initialized (ADR-026)");

  const store: ReceiptStore = {
    async createReceipt(input) {
      const result = await pool.query(
        `INSERT INTO import_receipts (source_type, source_meta, mapping, layer, changeset, inverse, unresolved, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${RECEIPT_COLS}`,
        [
          input.sourceType,
          JSON.stringify(input.sourceMeta ?? {}),
          input.mapping ? JSON.stringify(input.mapping) : null,
          input.layer,
          JSON.stringify(input.changeset ?? {}),
          JSON.stringify(input.inverse ?? {}),
          input.unresolved ? JSON.stringify(input.unresolved) : null,
          new Date().toISOString(),
        ],
      );
      log.fleet.debug({ id: result.rows[0].id, sourceType: input.sourceType, layer: input.layer }, "receipt created");
      return result.rows[0] as ImportReceipt;
    },

    async listReceipts(limit, layer) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      if (layer) { clauses.push(`layer = $${idx++}`); params.push(layer); }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limitClause = limit ? `LIMIT $${idx++}` : "";
      if (limit) params.push(limit);
      const result = await pool.query(
        `SELECT ${RECEIPT_COLS} FROM import_receipts ${where} ORDER BY created_at DESC ${limitClause}`,
        params,
      );
      return result.rows as ImportReceipt[];
    },

    async getReceipt(id) {
      const result = await pool.query(
        `SELECT ${RECEIPT_COLS} FROM import_receipts WHERE id = $1`, [id],
      );
      return (result.rows[0] as ImportReceipt) ?? null;
    },

    async undoReceipt(id) {
      const receipt = await store.getReceipt(id);
      if (!receipt) {
        return { success: false, message: `Receipt ${id} not found` };
      }

      // For reference layer, check for composition dependencies before allowing undo
      if (receipt.layer === "reference") {
        // Check if any added reference officers/ships are used in bridge_core_members or loadouts
        const addedIds = (receipt.changeset.added ?? []).map((item) => (item as Record<string, unknown>).id).filter(Boolean);
        if (addedIds.length > 0) {
          // Check bridge_core_members
          const bcmCheck = await pool.query(
            `SELECT officer_id FROM bridge_core_members WHERE officer_id = ANY($1) LIMIT 1`,
            [addedIds],
          ).catch(() => ({ rows: [] }));

          // Check loadouts (by ship_id)
          const loadoutCheck = await pool.query(
            `SELECT ship_id FROM loadouts WHERE ship_id = ANY($1) LIMIT 1`,
            [addedIds],
          ).catch(() => ({ rows: [] }));

          if (bcmCheck.rows.length > 0 || loadoutCheck.rows.length > 0) {
            return {
              success: false,
              message: "Cannot undo reference import: imported items are used in composition entities (bridge cores, loadouts). Remove those dependencies first.",
              inverse: receipt.inverse,
            };
          }
        }
      }

      // Return the inverse changeset for the caller to apply
      // The actual application of the inverse depends on the layer:
      // - ownership: reverse overlay upserts (handled by caller)
      // - reference: reverse reference upserts (handled by caller)
      // - composition: reverse composition changes (handled by caller)
      return {
        success: true,
        message: `Undo ready for receipt ${id} (${receipt.sourceType}, ${receipt.layer})`,
        inverse: receipt.inverse,
      };
    },

    async resolveReceiptItems(id, resolvedItems) {
      const receipt = await store.getReceipt(id);
      if (!receipt) throw new Error(`Receipt ${id} not found`);

      // Move resolved items from unresolved → changeset.added
      const currentUnresolved = (receipt.unresolved ?? []) as Record<string, unknown>[];
      const resolvedSet = new Set(resolvedItems.map((item) => JSON.stringify(item)));
      const stillUnresolved = currentUnresolved.filter(
        (item) => !resolvedSet.has(JSON.stringify(item)),
      );
      const newlyResolved = currentUnresolved.filter(
        (item) => resolvedSet.has(JSON.stringify(item)),
      );

      const updatedChangeset = {
        ...receipt.changeset,
        added: [...(receipt.changeset.added ?? []), ...newlyResolved],
      };

      const result = await pool.query(
        `UPDATE import_receipts SET
          changeset = $1,
          unresolved = $2
         WHERE id = $3 RETURNING ${RECEIPT_COLS}`,
        [
          JSON.stringify(updatedChangeset),
          stillUnresolved.length > 0 ? JSON.stringify(stillUnresolved) : null,
          id,
        ],
      );

      return result.rows[0] as ImportReceipt;
    },

    async counts() {
      const result = await pool.query(`SELECT COUNT(*)::int AS total FROM import_receipts`);
      return { total: result.rows[0].total };
    },

    close() {
      // Pool lifecycle managed by caller
    },
  };

  return store;
}
