/**
 * receipt-store.ts — ADR-026 Import Receipt Data Layer
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Tracks every import/commit as a receipt with changeset, inverse (for undo),
 * and unresolved items (for ADR-026a A4 "continue resolving later").
 *
 * Security (#94):
 * - user_id column + RLS enforces per-user isolation
 * - ReceiptStoreFactory.forUser(userId) → user-scoped ReceiptStore
 *
 * Pattern: ReceiptStoreFactory.forUser(userId) → ReceiptStore.
 */

import { initSchema, withUserScope, withUserRead, type Pool } from "../db.js";
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
  // Drop + recreate with user_id (#94)
  `DROP TABLE IF EXISTS import_receipts CASCADE`,

  `CREATE TABLE IF NOT EXISTS import_receipts (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
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
  `CREATE INDEX IF NOT EXISTS idx_receipts_user ON import_receipts(user_id)`,

  // RLS
  `ALTER TABLE import_receipts ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE import_receipts FORCE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'import_receipts' AND policyname = 'import_receipts_user_isolation'
    ) THEN
      CREATE POLICY import_receipts_user_isolation ON import_receipts
        USING (user_id = current_setting('app.current_user_id', true))
        WITH CHECK (user_id = current_setting('app.current_user_id', true));
    END IF;
  END $$`,
];

// ═══════════════════════════════════════════════════════════
// SQL Fragments
// ═══════════════════════════════════════════════════════════

const RECEIPT_COLS = `id, source_type AS "sourceType", source_meta AS "sourceMeta",
  mapping, layer, changeset, inverse, unresolved, created_at AS "createdAt"`;

// ═══════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════

function createScopedReceiptStore(pool: Pool, userId: string): ReceiptStore {

  const store: ReceiptStore = {
    async createReceipt(input) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(
          `INSERT INTO import_receipts (user_id, source_type, source_meta, mapping, layer, changeset, inverse, unresolved, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${RECEIPT_COLS}`,
          [
            userId,
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
      });
    },

    async listReceipts(limit, layer) {
      return withUserRead(pool, userId, async (client) => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (layer) { clauses.push(`layer = $${idx++}`); params.push(layer); }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const limitClause = limit ? `LIMIT $${idx++}` : "";
        if (limit) params.push(limit);
        const result = await client.query(
          `SELECT ${RECEIPT_COLS} FROM import_receipts ${where} ORDER BY created_at DESC ${limitClause}`,
          params,
        );
        return result.rows as ImportReceipt[];
      });
    },

    async getReceipt(id) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(
          `SELECT ${RECEIPT_COLS} FROM import_receipts WHERE id = $1`, [id],
        );
        return (result.rows[0] as ImportReceipt) ?? null;
      });
    },

    async undoReceipt(id) {
      return withUserRead(pool, userId, async (client) => {
        const receiptResult = await client.query(
          `SELECT ${RECEIPT_COLS} FROM import_receipts WHERE id = $1`, [id],
        );
        const receipt = (receiptResult.rows[0] as ImportReceipt) ?? null;
        if (!receipt) {
          return { success: false, message: `Receipt ${id} not found` };
        }

        // For reference layer, check for composition dependencies before allowing undo
        if (receipt.layer === "reference") {
          const addedIds = (receipt.changeset.added ?? []).map((item) => (item as Record<string, unknown>).id).filter(Boolean);
          if (addedIds.length > 0) {
            const bcmCheck = await client.query(
              `SELECT officer_id FROM bridge_core_members WHERE officer_id = ANY($1) LIMIT 1`,
              [addedIds],
            ).catch(() => ({ rows: [] }));

            const loadoutCheck = await client.query(
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

        return {
          success: true,
          message: `Undo ready for receipt ${id} (${receipt.sourceType}, ${receipt.layer})`,
          inverse: receipt.inverse,
        };
      });
    },

    async resolveReceiptItems(id, resolvedItems) {
      return withUserScope(pool, userId, async (client) => {
        const receiptResult = await client.query(
          `SELECT ${RECEIPT_COLS} FROM import_receipts WHERE id = $1`, [id],
        );
        const receipt = (receiptResult.rows[0] as ImportReceipt) ?? null;
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

        const result = await client.query(
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
      });
    },

    async counts() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT COUNT(*)::int AS total FROM import_receipts`);
        return { total: result.rows[0].total };
      });
    },

    close() {
      // Pool lifecycle managed by caller
    },
  };

  return store;
}

// ═══════════════════════════════════════════════════════════
// Factory (ADR-026 + #94)
// ═══════════════════════════════════════════════════════════

export class ReceiptStoreFactory {
  constructor(private pool: Pool) {}
  forUser(userId: string): ReceiptStore {
    return createScopedReceiptStore(this.pool, userId);
  }
}

/** Initialise schema and return a factory that produces user-scoped stores. */
export async function createReceiptStoreFactory(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<ReceiptStoreFactory> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  log.boot.debug("receipt store initialized (ADR-026, user-scoped)");
  return new ReceiptStoreFactory(runtimePool ?? adminPool);
}

/** Backward-compatible helper — creates a factory and returns a "local" user store. */
export async function createReceiptStore(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<ReceiptStore> {
  const factory = await createReceiptStoreFactory(adminPool, runtimePool);
  return factory.forUser("local");
}
