/**
 * operation-event-store.ts — ADR-037 Realtime Operation Event Stream Store
 *
 * Durable event log backing SSE replay/snapshot endpoints.
 */

import { initSchema, withUserScope, withUserRead, type Pool } from "../db.js";

export interface OperationEvent {
  seq: number;
  topic: string;
  operationId: string;
  userId: string;
  sessionId: string;
  tabId: string;
  eventType: string;
  status: string | null;
  payloadJson: Record<string, unknown> | null;
  createdAt: string;
}

export interface OperationRouting {
  sessionId: string;
  tabId: string;
}

export interface EmitOperationEventInput {
  topic: string;
  operationId: string;
  routing: OperationRouting;
  eventType: string;
  status?: string;
  payloadJson?: Record<string, unknown>;
}

export interface OperationEventStore {
  register(topic: string, operationId: string, routing: OperationRouting): Promise<void>;
  emit(input: EmitOperationEventInput): Promise<OperationEvent>;
  listSince(topic: string, operationId: string, afterSeq: number, limit?: number): Promise<OperationEvent[]>;
  latest(topic: string, operationId: string): Promise<OperationEvent | null>;
  getRouting(topic: string, operationId: string): Promise<OperationRouting | null>;
  close(): void;
}

export interface OperationEventStoreFactory {
  forUser(userId: string): OperationEventStore;
  close(): void;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS operation_events (
    seq BIGSERIAL PRIMARY KEY,
    topic TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    tab_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    status TEXT,
    payload_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS operation_streams (
    topic TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (topic, operation_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_operation_streams_user_created
    ON operation_streams(user_id, created_at DESC)`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'operation_events' AND column_name = 'session_id'
    ) THEN
      ALTER TABLE operation_events ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'operation_events' AND column_name = 'tab_id'
    ) THEN
      ALTER TABLE operation_events ADD COLUMN tab_id TEXT NOT NULL DEFAULT '';
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_operation_events_topic_id_seq
    ON operation_events(topic, operation_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_operation_events_user_created
    ON operation_events(user_id, created_at DESC)`,
  `ALTER TABLE operation_events ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE operation_events FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE operation_streams ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE operation_streams FORCE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'operation_events' AND policyname = 'operation_events_user_isolation'
    ) THEN
      CREATE POLICY operation_events_user_isolation ON operation_events
        USING (user_id = current_setting('app.current_user_id', true))
        WITH CHECK (user_id = current_setting('app.current_user_id', true));
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'operation_streams' AND policyname = 'operation_streams_user_isolation'
    ) THEN
      CREATE POLICY operation_streams_user_isolation ON operation_streams
        USING (user_id = current_setting('app.current_user_id', true))
        WITH CHECK (user_id = current_setting('app.current_user_id', true));
    END IF;
  END $$`,
];

const EVENT_COLS = `seq, topic, operation_id AS "operationId", user_id AS "userId",
  session_id AS "sessionId", tab_id AS "tabId",
  event_type AS "eventType", status, payload_json AS "payloadJson", created_at AS "createdAt"`;

function mapOperationEvent(row: Record<string, unknown>): OperationEvent {
  return {
    seq: Number(row.seq),
    topic: String(row.topic),
    operationId: String(row.operationId),
    userId: String(row.userId),
    sessionId: String(row.sessionId ?? ""),
    tabId: String(row.tabId ?? ""),
    eventType: String(row.eventType),
    status: row.status == null ? null : String(row.status),
    payloadJson: (row.payloadJson as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(row.createdAt)).toISOString(),
  };
}

function createScopedStore(pool: Pool, userId: string): OperationEventStore {
  return {
    async register(topic, operationId, routing) {
      return withUserScope(pool, userId, async (client) => {
        await client.query(
          `INSERT INTO operation_streams
             (topic, operation_id, user_id, session_id, tab_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (topic, operation_id, user_id)
           DO UPDATE SET
             session_id = EXCLUDED.session_id,
             tab_id = EXCLUDED.tab_id`,
          [topic, operationId, userId, routing.sessionId, routing.tabId],
        );
      });
    },

    async emit(input) {
      return withUserScope(pool, userId, async (client) => {
        await client.query(
          `INSERT INTO operation_streams
             (topic, operation_id, user_id, session_id, tab_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (topic, operation_id, user_id)
           DO UPDATE SET
             session_id = EXCLUDED.session_id,
             tab_id = EXCLUDED.tab_id`,
          [input.topic, input.operationId, userId, input.routing.sessionId, input.routing.tabId],
        );

        const result = await client.query(
          `INSERT INTO operation_events
             (topic, operation_id, user_id, session_id, tab_id, event_type, status, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${EVENT_COLS}`,
          [
            input.topic,
            input.operationId,
            userId,
            input.routing.sessionId,
            input.routing.tabId,
            input.eventType,
            input.status ?? null,
            input.payloadJson ? JSON.stringify(input.payloadJson) : null,
          ],
        );
        return mapOperationEvent(result.rows[0] as Record<string, unknown>);
      });
    },

    async listSince(topic, operationId, afterSeq, limit = 100) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(
          `SELECT ${EVENT_COLS}
           FROM operation_events
           WHERE topic = $1
             AND operation_id = $2
             AND user_id = $3
             AND seq > $4
           ORDER BY seq ASC
           LIMIT $5`,
          [topic, operationId, userId, Math.max(0, afterSeq), Math.max(1, Math.min(500, limit))],
        );
        return result.rows.map((row) => mapOperationEvent(row as Record<string, unknown>));
      });
    },

    async latest(topic, operationId) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(
          `SELECT ${EVENT_COLS}
           FROM operation_events
           WHERE topic = $1
             AND operation_id = $2
             AND user_id = $3
           ORDER BY seq DESC
           LIMIT 1`,
          [topic, operationId, userId],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        return row ? mapOperationEvent(row) : null;
      });
    },

    async getRouting(topic, operationId) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(
          `SELECT session_id AS "sessionId", tab_id AS "tabId"
           FROM operation_streams
           WHERE topic = $1
             AND operation_id = $2
             AND user_id = $3
           LIMIT 1`,
          [topic, operationId, userId],
        );
        const row = result.rows[0] as { sessionId: string; tabId: string } | undefined;
        return row ? { sessionId: row.sessionId, tabId: row.tabId } : null;
      });
    },

    close(): void {
      // Pool lifecycle managed externally
    },
  };
}

export async function createOperationEventStoreFactory(adminPool: Pool, runtimePool?: Pool): Promise<OperationEventStoreFactory> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  return {
    forUser(userId: string): OperationEventStore {
      return createScopedStore(pool, userId);
    },
    close(): void {
      // Pool lifecycle managed externally
    },
  };
}

export async function emitOperationEvent(
  factory: OperationEventStoreFactory | null,
  userId: string,
  input: EmitOperationEventInput,
): Promise<OperationEvent | null> {
  if (!factory) return null;
  return factory.forUser(userId).emit(input);
}
