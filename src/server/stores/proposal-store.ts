/**
 * proposal-store.ts — ADR-026b Mutation Proposal Data Layer
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Persistence layer for the "Proposal → Confirm → Apply" safe mutation flow.
 * Every mutating tool action is first stored as a proposal, then explicitly
 * confirmed before being applied.
 *
 * Security (#93):
 * - user_id column + RLS enforces per-user isolation
 * - ProposalStoreFactory.forUser(userId) → user-scoped ProposalStore
 *
 * Pattern: ProposalStoreFactory.forUser(userId) → ProposalStore.
 */

import { randomUUID } from "node:crypto";
import { initSchema, withUserScope, withUserRead, type Pool } from "../db.js";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type ProposalStatus = "proposed" | "applied" | "declined" | "expired";

export interface BatchItem {
  tool: string;
  args: Record<string, unknown>;
  preview: string;
}

export interface MutationProposal {
  id: string;
  userId: string;
  schemaVersion: number;
  tool: string;
  argsJson: Record<string, unknown>;
  argsHash: string;
  proposalJson: Record<string, unknown>;
  batchItems: BatchItem[] | null;
  status: ProposalStatus;
  declineReason: string | null;
  appliedReceiptId: number | null;
  createdAt: string;
  expiresAt: string;
  appliedAt: string | null;
  declinedAt: string | null;
}

export interface CreateProposalInput {
  tool: string;
  argsJson: Record<string, unknown>;
  argsHash: string;
  proposalJson: Record<string, unknown>;
  batchItems?: BatchItem[] | null;
  expiresAt: string; // ISO timestamp
}

// ═══════════════════════════════════════════════════════════
// Store Interface
// ═══════════════════════════════════════════════════════════

export interface ProposalStore {
  create(input: CreateProposalInput): Promise<MutationProposal>;
  get(id: string): Promise<MutationProposal | null>;
  apply(id: string, receiptId: number): Promise<MutationProposal>;
  decline(id: string, reason?: string): Promise<MutationProposal>;
  list(options?: { status?: ProposalStatus; limit?: number }): Promise<MutationProposal[]>;
  expireStale(): Promise<number>;
  counts(): Promise<{ total: number; proposed: number; applied: number; declined: number; expired: number }>;
  close(): void;
}

// ═══════════════════════════════════════════════════════════
// Schema DDL
// ═══════════════════════════════════════════════════════════

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mutation_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    tool TEXT NOT NULL,
    args_json JSONB NOT NULL,
    args_hash TEXT NOT NULL,
    proposal_json JSONB NOT NULL,
    batch_items JSONB,
    status TEXT NOT NULL CHECK (status IN ('proposed','applied','declined','expired')),
    decline_reason TEXT,
    applied_receipt_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    applied_at TIMESTAMPTZ,
    declined_at TIMESTAMPTZ
  )`,
  // Add batch_items column if table existed before this migration
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'mutation_proposals' AND column_name = 'batch_items'
    ) THEN
      ALTER TABLE mutation_proposals ADD COLUMN batch_items JSONB;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_proposals_user_status ON mutation_proposals(user_id, status)`,

  // RLS
  `ALTER TABLE mutation_proposals ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE mutation_proposals FORCE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'mutation_proposals' AND policyname = 'mutation_proposals_user_isolation'
    ) THEN
      CREATE POLICY mutation_proposals_user_isolation ON mutation_proposals
        USING (user_id = current_setting('app.current_user_id', true))
        WITH CHECK (user_id = current_setting('app.current_user_id', true));
    END IF;
  END $$`,
];

// ═══════════════════════════════════════════════════════════
// SQL Fragments
// ═══════════════════════════════════════════════════════════

const PROPOSAL_COLS = `id, user_id AS "userId", schema_version AS "schemaVersion",
  tool, args_json AS "argsJson", args_hash AS "argsHash",
  proposal_json AS "proposalJson", batch_items AS "batchItems", status,
  decline_reason AS "declineReason",
  applied_receipt_id AS "appliedReceiptId",
  created_at AS "createdAt", expires_at AS "expiresAt",
  applied_at AS "appliedAt", declined_at AS "declinedAt"`;

function mapProposal(row: Record<string, unknown>): MutationProposal {
  return {
    id: String(row.id),
    userId: String(row.userId),
    schemaVersion: Number(row.schemaVersion),
    tool: String(row.tool),
    argsJson: (row.argsJson as Record<string, unknown>) ?? {},
    argsHash: String(row.argsHash),
    proposalJson: (row.proposalJson as Record<string, unknown>) ?? {},
    batchItems: (row.batchItems as BatchItem[] | null) ?? null,
    status: String(row.status) as ProposalStatus,
    declineReason: row.declineReason == null ? null : String(row.declineReason),
    appliedReceiptId: row.appliedReceiptId == null ? null : Number(row.appliedReceiptId),
    createdAt: new Date(String(row.createdAt)).toISOString(),
    expiresAt: new Date(String(row.expiresAt)).toISOString(),
    appliedAt: row.appliedAt == null ? null : new Date(String(row.appliedAt)).toISOString(),
    declinedAt: row.declinedAt == null ? null : new Date(String(row.declinedAt)).toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════

function createScopedStore(pool: Pool, userId: string): ProposalStore {

  const store: ProposalStore = {
    async create(input) {
      return withUserScope(pool, userId, async (client) => {
        const id = `prop_${randomUUID()}`;
        const result = await client.query(
          `INSERT INTO mutation_proposals
            (id, user_id, schema_version, tool, args_json, args_hash, proposal_json, batch_items, status, expires_at)
           VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'proposed', $8)
           RETURNING ${PROPOSAL_COLS}`,
          [
            id,
            userId,
            input.tool,
            JSON.stringify(input.argsJson),
            input.argsHash,
            JSON.stringify(input.proposalJson),
            input.batchItems ? JSON.stringify(input.batchItems) : null,
            input.expiresAt,
          ],
        );
        log.fleet.debug({ id, tool: input.tool }, "proposal created");
        return mapProposal(result.rows[0] as Record<string, unknown>);
      });
    },

    async get(id) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(
          `SELECT ${PROPOSAL_COLS} FROM mutation_proposals WHERE id = $1 AND user_id = $2`,
          [id, userId],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        return row ? mapProposal(row) : null;
      });
    },

    async apply(id, receiptId) {
      type ApplyResult = { kind: "applied"; proposal: MutationProposal } | { kind: "expired"; expiresAt: string };
      const result = await withUserScope(pool, userId, async (client): Promise<ApplyResult> => {
        // Fetch current state
        const current = await client.query(
          `SELECT ${PROPOSAL_COLS} FROM mutation_proposals WHERE id = $1 AND user_id = $2`,
          [id, userId],
        );
        const row = current.rows[0] as Record<string, unknown> | undefined;
        const proposal = row ? mapProposal(row) : null;
        if (!proposal) {
          throw new Error(`Proposal ${id} not found`);
        }
        if (proposal.status !== "proposed") {
          throw new Error(
            `Cannot apply proposal ${id}: status is '${proposal.status}', expected 'proposed'`,
          );
        }

        // Check expiry — if past due, mark expired then throw
        if (new Date(proposal.expiresAt) < new Date()) {
          await client.query(
            `UPDATE mutation_proposals
             SET status = 'expired'
             WHERE id = $1 AND user_id = $2`,
            [id, userId],
          );
          return { kind: "expired", expiresAt: proposal.expiresAt };
        }

        const updated = await client.query(
          `UPDATE mutation_proposals
           SET status = 'applied', applied_at = NOW(), applied_receipt_id = $1
           WHERE id = $2 AND user_id = $3
           RETURNING ${PROPOSAL_COLS}`,
          [receiptId, id, userId],
        );
        log.fleet.debug({ id, receiptId }, "proposal applied");
        return {
          kind: "applied",
          proposal: mapProposal(updated.rows[0] as Record<string, unknown>),
        };
      });

      if (result.kind === "expired") {
        throw new Error(
          `Cannot apply proposal ${id}: proposal has expired (expired at ${result.expiresAt})`,
        );
      }
      return result.proposal;
    },

    async decline(id, reason) {
      return withUserScope(pool, userId, async (client) => {
        // Fetch current state
        const current = await client.query(
          `SELECT ${PROPOSAL_COLS} FROM mutation_proposals WHERE id = $1 AND user_id = $2`,
          [id, userId],
        );
        const row = current.rows[0] as Record<string, unknown> | undefined;
        const proposal = row ? mapProposal(row) : null;
        if (!proposal) {
          throw new Error(`Proposal ${id} not found`);
        }
        if (proposal.status !== "proposed") {
          throw new Error(
            `Cannot decline proposal ${id}: status is '${proposal.status}', expected 'proposed'`,
          );
        }

        const result = await client.query(
          `UPDATE mutation_proposals
           SET status = 'declined', declined_at = NOW(), decline_reason = $1
           WHERE id = $2 AND user_id = $3
           RETURNING ${PROPOSAL_COLS}`,
          [reason ?? null, id, userId],
        );
        log.fleet.debug({ id, reason }, "proposal declined");
        return mapProposal(result.rows[0] as Record<string, unknown>);
      });
    },

    async list(options) {
      return withUserRead(pool, userId, async (client) => {
        const clauses: string[] = ["user_id = $1"];
        const params: unknown[] = [userId];
        let idx = 2;

        if (options?.status) {
          clauses.push(`status = $${idx++}`);
          params.push(options.status);
        }

        const where = `WHERE ${clauses.join(" AND ")}`;
        const limitClause = options?.limit ? `LIMIT $${idx++}` : "";
        if (options?.limit) params.push(options.limit);

        const result = await client.query(
          `SELECT ${PROPOSAL_COLS} FROM mutation_proposals ${where} ORDER BY created_at DESC ${limitClause}`,
          params,
        );
        return result.rows.map((row) => mapProposal(row as Record<string, unknown>));
      });
    },

    async expireStale() {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(
          `UPDATE mutation_proposals
           SET status = 'expired'
           WHERE user_id = $1 AND status = 'proposed' AND expires_at < NOW()`,
          [userId],
        );
        const count = result.rowCount ?? 0;
        if (count > 0) {
          log.fleet.debug({ count }, "stale proposals expired");
        }
        return count;
      });
    },

    async counts() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(
          `SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'proposed')::int AS proposed,
            COUNT(*) FILTER (WHERE status = 'applied')::int AS applied,
            COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
            COUNT(*) FILTER (WHERE status = 'expired')::int AS expired
           FROM mutation_proposals
           WHERE user_id = $1`,
          [userId],
        );
        return result.rows[0] as {
          total: number;
          proposed: number;
          applied: number;
          declined: number;
          expired: number;
        };
      });
    },

    close() {
      // Pool lifecycle managed by caller
    },
  };

  return store;
}

// ═══════════════════════════════════════════════════════════
// Factory (ADR-026b + #93)
// ═══════════════════════════════════════════════════════════

export class ProposalStoreFactory {
  constructor(private pool: Pool) {}
  forUser(userId: string): ProposalStore {
    return createScopedStore(this.pool, userId);
  }
}

/** Initialise schema and return a factory that produces user-scoped stores. */
export async function createProposalStoreFactory(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<ProposalStoreFactory> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  log.boot.debug("proposal store initialized (ADR-026b, user-scoped)");
  return new ProposalStoreFactory(runtimePool ?? adminPool);
}

/** Backward-compatible helper — creates a factory and returns a "local" user store. */
export async function createProposalStore(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<ProposalStore> {
  const factory = await createProposalStoreFactory(adminPool, runtimePool);
  return factory.forUser("local");
}
