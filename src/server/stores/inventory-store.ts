/**
 * inventory-store.ts — Per-User Inventory Store (ADR-028 Phase 3)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Tracks user inventory resources (ore, gas, crystal, parts, currency, blueprints)
 * with RLS scoping and category-based reads for planning tools.
 */

import { initSchema, withUserRead, withUserScope, type Pool } from "../db.js";
import { log } from "../logger.js";

export type InventoryCategory = "ore" | "gas" | "crystal" | "parts" | "currency" | "blueprint" | "other";

export interface InventoryItemInput {
  category: InventoryCategory;
  name: string;
  grade: string | null;
  quantity: number;
  unit: string | null;
}

export interface UpsertInventoryInput {
  source: string | null;
  capturedAt: string | null;
  items: InventoryItemInput[];
}

export interface InventoryItemRecord {
  id: number;
  category: InventoryCategory;
  name: string;
  grade: string | null;
  quantity: number;
  unit: string | null;
  source: string | null;
  capturedAt: string | null;
  updatedAt: string;
}

export interface InventoryCategoryView {
  category: InventoryCategory;
  items: InventoryItemRecord[];
  totals: {
    itemCount: number;
    totalQuantity: number;
  };
}

export interface InventoryStore {
  upsertItems(input: UpsertInventoryInput): Promise<{ upserted: number; categories: number }>;
  listItems(filters?: { category?: InventoryCategory; q?: string }): Promise<InventoryItemRecord[]>;
  listByCategory(filters?: { category?: InventoryCategory; q?: string }): Promise<InventoryCategoryView[]>;
  counts(): Promise<{ items: number; categories: number }>;
  close(): void;
}

export interface InventoryStoreFactory {
  forUser(userId: string): InventoryStore;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS inventory_items (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    grade TEXT NOT NULL DEFAULT '',
    quantity BIGINT NOT NULL CHECK (quantity >= 0),
    unit TEXT,
    source TEXT,
    captured_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT inventory_items_unique_item UNIQUE (user_id, category, name, grade)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_items_user ON inventory_items(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items(category)`,
  `ALTER TABLE inventory_items ALTER COLUMN grade SET DEFAULT ''`,
  `UPDATE inventory_items SET grade = '' WHERE grade IS NULL`,
  `ALTER TABLE inventory_items ALTER COLUMN grade SET NOT NULL`,
  `ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'inventory_items' AND policyname = 'inventory_items_user_isolation'
    ) THEN
      CREATE POLICY inventory_items_user_isolation ON inventory_items
        USING (user_id = current_setting('app.current_user_id', true))
        WITH CHECK (user_id = current_setting('app.current_user_id', true));
    END IF;
  END $$`,
];

const SQL = {
  upsertItem: `INSERT INTO inventory_items (
      user_id, category, name, grade, quantity, unit, source, captured_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, NOW()
    )
    ON CONFLICT (user_id, category, name, grade) DO UPDATE SET
      quantity = EXCLUDED.quantity,
      unit = EXCLUDED.unit,
      source = EXCLUDED.source,
      captured_at = EXCLUDED.captured_at,
      updated_at = NOW()`,
  listItems: `SELECT id, category, name, grade, quantity, unit, source, captured_at, updated_at
    FROM inventory_items
    WHERE user_id = $1
      AND ($2::text IS NULL OR category = $2)
      AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%')
    ORDER BY category ASC, name ASC`,
  counts: `SELECT
    COUNT(*) AS items,
    COUNT(DISTINCT category) AS categories
    FROM inventory_items
    WHERE user_id = $1`,
};

function mapInventoryRow(row: Record<string, unknown>): InventoryItemRecord {
  return {
    id: Number(row.id),
    category: String(row.category) as InventoryCategory,
    name: String(row.name),
    grade: row.grade == null || String(row.grade) === "" ? null : String(row.grade),
    quantity: Number(row.quantity),
    unit: row.unit == null ? null : String(row.unit),
    source: row.source == null ? null : String(row.source),
    capturedAt: row.captured_at ? new Date(String(row.captured_at)).toISOString() : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function createScopedInventoryStore(pool: Pool, userId: string): InventoryStore {
  return {
    async upsertItems(input) {
      return withUserScope(pool, userId, async (client) => {
        for (const item of input.items) {
          await client.query(SQL.upsertItem, [
            userId,
            item.category,
            item.name.trim(),
            item.grade ?? "",
            Math.max(0, Math.floor(item.quantity)),
            item.unit,
            input.source,
            input.capturedAt,
          ]);
        }

        const categories = new Set(input.items.map((item) => item.category)).size;
        log.fleet.info({ userId, items: input.items.length, categories }, "inventory items upserted");
        return { upserted: input.items.length, categories };
      });
    },

    async listItems(filters) {
      return withUserRead(pool, userId, async (client) => {
        const category = filters?.category ?? null;
        const q = filters?.q?.trim() || null;
        const result = await client.query(SQL.listItems, [userId, category, q]);
        return result.rows.map((row) => mapInventoryRow(row as Record<string, unknown>));
      });
    },

    async listByCategory(filters) {
      const items = await this.listItems(filters);
      const grouped = new Map<InventoryCategory, InventoryItemRecord[]>();
      for (const item of items) {
        const list = grouped.get(item.category) ?? [];
        list.push(item);
        grouped.set(item.category, list);
      }

      return Array.from(grouped.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, categoryItems]) => ({
          category,
          items: categoryItems,
          totals: {
            itemCount: categoryItems.length,
            totalQuantity: categoryItems.reduce((sum, item) => sum + item.quantity, 0),
          },
        }));
    },

    async counts() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(SQL.counts, [userId]);
        const row = result.rows[0] as { items: string | number; categories: string | number };
        return {
          items: Number(row.items),
          categories: Number(row.categories),
        };
      });
    },

    close() {
    },
  };
}

export async function createInventoryStoreFactory(adminPool: Pool, runtimePool?: Pool): Promise<InventoryStoreFactory> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  return {
    forUser(userId: string) {
      return createScopedInventoryStore(pool, userId);
    },
  };
}
