/**
 * research-store.ts — Per-User Research Tree Store (ADR-028 Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Stores Admiral research nodes + completion state for research-aware planning.
 * User-scoped via RLS and factory pattern (#85 parity with overlay/targets).
 */

import { initSchema, withUserRead, withUserScope, type Pool } from "../db.js";
import { log } from "../logger.js";

export interface ResearchBuff {
  kind: "ship" | "officer" | "resource" | "combat" | "other";
  metric: string;
  value: number;
  unit: "percent" | "flat" | "multiplier";
}

export interface ResearchNodeInput {
  nodeId: string;
  tree: string;
  name: string;
  maxLevel: number;
  dependencies: string[];
  buffs: ResearchBuff[];
}

export interface ResearchStateInput {
  nodeId: string;
  level: number;
  completed: boolean;
  updatedAt: string | null;
}

export interface ReplaceResearchSnapshotInput {
  source: string | null;
  capturedAt: string | null;
  nodes: ResearchNodeInput[];
  state: ResearchStateInput[];
}

export interface ResearchNodeRecord {
  nodeId: string;
  tree: string;
  name: string;
  maxLevel: number;
  dependencies: string[];
  buffs: ResearchBuff[];
  level: number;
  completed: boolean;
  stateUpdatedAt: string | null;
  source: string | null;
  capturedAt: string | null;
  updatedAt: string;
}

export interface ResearchTreeView {
  tree: string;
  nodes: ResearchNodeRecord[];
  totals: {
    nodes: number;
    completed: number;
    inProgress: number;
    avgCompletionPct: number;
  };
}

export interface ResearchStore {
  replaceSnapshot(input: ReplaceResearchSnapshotInput): Promise<{ nodes: number; trees: number }>;
  listNodes(): Promise<ResearchNodeRecord[]>;
  listByTree(filters?: { tree?: string; includeCompleted?: boolean }): Promise<ResearchTreeView[]>;
  counts(): Promise<{ nodes: number; trees: number; completed: number }>;
  close(): void;
}

export interface ResearchStoreFactory {
  forUser(userId: string): ResearchStore;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS research_nodes (
    user_id TEXT NOT NULL DEFAULT 'local',
    node_id TEXT NOT NULL,
    tree TEXT NOT NULL,
    name TEXT NOT NULL,
    max_level INTEGER NOT NULL CHECK (max_level >= 1),
    dependencies JSONB NOT NULL DEFAULT '[]'::jsonb,
    buffs JSONB NOT NULL DEFAULT '[]'::jsonb,
    level INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    state_updated_at TIMESTAMPTZ,
    source TEXT,
    captured_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, node_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_research_nodes_user ON research_nodes(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_research_nodes_tree ON research_nodes(tree)`,
  `CREATE INDEX IF NOT EXISTS idx_research_nodes_completed ON research_nodes(completed)`,
  `ALTER TABLE research_nodes ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE research_nodes FORCE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'research_nodes' AND policyname = 'research_nodes_user_isolation'
    ) THEN
      CREATE POLICY research_nodes_user_isolation ON research_nodes
        USING (user_id = current_setting('app.current_user_id', true))
        WITH CHECK (user_id = current_setting('app.current_user_id', true));
    END IF;
  END $$`,
];

const SQL = {
  deleteAll: `DELETE FROM research_nodes WHERE user_id = $1`,
  insertNode: `INSERT INTO research_nodes (
      user_id, node_id, tree, name, max_level, dependencies, buffs,
      level, completed, state_updated_at, source, captured_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
      $8, $9, $10::timestamptz, $11, $12::timestamptz, NOW()
    )`,
  listNodes: `SELECT
      node_id, tree, name, max_level, dependencies, buffs,
      level, completed, state_updated_at, source, captured_at, updated_at
    FROM research_nodes
    WHERE user_id = $1
    ORDER BY tree ASC, name ASC`,
  counts: `SELECT
      COUNT(*) AS nodes,
      COUNT(DISTINCT tree) AS trees,
      COUNT(*) FILTER (WHERE completed = TRUE) AS completed
    FROM research_nodes
    WHERE user_id = $1`,
};

function mapNodeRow(row: Record<string, unknown>): ResearchNodeRecord {
  return {
    nodeId: String(row.node_id),
    tree: String(row.tree),
    name: String(row.name),
    maxLevel: Number(row.max_level),
    dependencies: (row.dependencies as string[] | null) ?? [],
    buffs: (row.buffs as ResearchBuff[] | null) ?? [],
    level: Number(row.level),
    completed: Boolean(row.completed),
    stateUpdatedAt: row.state_updated_at ? new Date(String(row.state_updated_at)).toISOString() : null,
    source: row.source == null ? null : String(row.source),
    capturedAt: row.captured_at ? new Date(String(row.captured_at)).toISOString() : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function createScopedResearchStore(pool: Pool, userId: string): ResearchStore {
  return {
    async replaceSnapshot(input) {
      return withUserScope(pool, userId, async (client) => {
        await client.query(SQL.deleteAll, [userId]);

        const stateMap = new Map(input.state.map((entry) => [entry.nodeId, entry]));
        for (const node of input.nodes) {
          const state = stateMap.get(node.nodeId);
          await client.query(SQL.insertNode, [
            userId,
            node.nodeId,
            node.tree,
            node.name,
            node.maxLevel,
            JSON.stringify(node.dependencies ?? []),
            JSON.stringify(node.buffs ?? []),
            state?.level ?? 0,
            state?.completed ?? false,
            state?.updatedAt ?? null,
            input.source ?? null,
            input.capturedAt ?? null,
          ]);
        }

        const treeCount = new Set(input.nodes.map((node) => node.tree)).size;
        log.fleet.info({ userId, nodes: input.nodes.length, trees: treeCount }, "research snapshot replaced");
        return { nodes: input.nodes.length, trees: treeCount };
      });
    },

    async listNodes() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(SQL.listNodes, [userId]);
        return result.rows.map((row) => mapNodeRow(row as Record<string, unknown>));
      });
    },

    async listByTree(filters) {
      const includeCompleted = filters?.includeCompleted ?? true;
      const treeFilter = filters?.tree?.trim().toLowerCase();
      const nodes = await this.listNodes();

      const filtered = nodes.filter((node) => {
        if (!includeCompleted && node.completed) return false;
        if (!treeFilter) return true;
        return node.tree.toLowerCase() === treeFilter;
      });

      const grouped = new Map<string, ResearchNodeRecord[]>();
      for (const node of filtered) {
        const list = grouped.get(node.tree) ?? [];
        list.push(node);
        grouped.set(node.tree, list);
      }

      return Array.from(grouped.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([tree, treeNodes]) => {
          const completed = treeNodes.filter((node) => node.completed).length;
          const inProgress = treeNodes.filter((node) => node.level > 0 && !node.completed).length;
          const completionSum = treeNodes.reduce((sum, node) => sum + Math.min(1, node.level / Math.max(1, node.maxLevel)), 0);
          const avgCompletionPct = treeNodes.length === 0 ? 0 : Math.round((completionSum / treeNodes.length) * 1000) / 10;

          return {
            tree,
            nodes: treeNodes,
            totals: {
              nodes: treeNodes.length,
              completed,
              inProgress,
              avgCompletionPct,
            },
          };
        });
    },

    async counts() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(SQL.counts, [userId]);
        const row = result.rows[0] as { nodes: string | number; trees: string | number; completed: string | number };
        return {
          nodes: Number(row.nodes),
          trees: Number(row.trees),
          completed: Number(row.completed),
        };
      });
    },

    close() {
    },
  };
}

export async function createResearchStoreFactory(adminPool: Pool, runtimePool?: Pool): Promise<ResearchStoreFactory> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  return {
    forUser(userId: string) {
      return createScopedResearchStore(pool, userId);
    },
  };
}
