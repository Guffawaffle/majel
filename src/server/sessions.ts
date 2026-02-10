/**
 * sessions.ts — Chat Session Store
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed local chat history. Each session stores its full
 * message log so users can browse and restore past conversations.
 *
 * Migrated to PostgreSQL in ADR-018 Phase 3.
 */

import { initSchema, type Pool } from "./db.js";
import { log } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────

export interface ChatMessage {
  id: number;
  role: "user" | "model" | "system" | "error";
  text: string;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Only populated when fetching a single session */
  messages?: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** First user message, for preview */
  preview: string | null;
}

export interface SessionStore {
  create(id: string, title?: string): Promise<ChatSession>;
  list(limit?: number): Promise<SessionSummary[]>;
  get(id: string): Promise<(ChatSession & { messages: ChatMessage[] }) | null>;
  updateTitle(id: string, title: string): Promise<boolean>;
  addMessage(sessionId: string, role: ChatMessage["role"], text: string): Promise<ChatMessage>;
  delete(id: string): Promise<boolean>;
  touch(id: string): Promise<void>;
  count(): Promise<number>;
  close(): void;
}

// ─── SQL ────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'model', 'system', 'error')),
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id, created_at)`,
];

const SQL = {
  insertSession: `INSERT INTO sessions (id, title, created_at, updated_at) VALUES ($1, $2, $3, $4)`,
  getSession: `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM sessions WHERE id = $1`,
  listSessions: `SELECT
    s.id,
    s.title,
    s.created_at AS "createdAt",
    s.updated_at AS "updatedAt",
    COUNT(m.id) AS "messageCount",
    (SELECT text FROM messages
     WHERE session_id = s.id AND role = 'user'
     ORDER BY created_at ASC LIMIT 1) AS preview
  FROM sessions s
  LEFT JOIN messages m ON m.session_id = s.id
  GROUP BY s.id
  ORDER BY s.updated_at DESC
  LIMIT $1`,
  updateTitle: `UPDATE sessions SET title = $1, updated_at = $2 WHERE id = $3`,
  touchSession: `UPDATE sessions SET updated_at = $1 WHERE id = $2`,
  deleteSession: `DELETE FROM sessions WHERE id = $1`,
  insertMessage: `INSERT INTO messages (session_id, role, text, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
  getMessages: `SELECT id, role, text, created_at AS "createdAt" FROM messages WHERE session_id = $1 ORDER BY created_at ASC`,
  countSessions: `SELECT COUNT(*) AS count FROM sessions`,
  sessionExists: `SELECT 1 FROM sessions WHERE id = $1`,
};

// ─── Implementation ─────────────────────────────────────────

/** Generate timestamp title: "20260208-055200" */
export function generateTimestampTitle(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

export async function createSessionStore(pool: Pool): Promise<SessionStore> {
  await initSchema(pool, SCHEMA_STATEMENTS);

  log.boot.debug("session store initialized (pg)");

  const store: SessionStore = {
    async create(id: string, title?: string): Promise<ChatSession> {
      const now = new Date().toISOString();
      const resolvedTitle = title || generateTimestampTitle();
      await pool.query(SQL.insertSession, [id, resolvedTitle, now, now]);
      log.settings.debug({ id, title: resolvedTitle }, "session created");
      return { id, title: resolvedTitle, createdAt: now, updatedAt: now };
    },

    async list(limit = 50): Promise<SessionSummary[]> {
      const result = await pool.query(SQL.listSessions, [limit]);
      return result.rows.map((r) => ({
        ...r,
        messageCount: Number(r.messageCount),
      })) as SessionSummary[];
    },

    async get(id: string) {
      const sessionResult = await pool.query(SQL.getSession, [id]);
      const session = sessionResult.rows[0] as ChatSession | undefined;
      if (!session) return null;
      const msgResult = await pool.query(SQL.getMessages, [id]);
      const messages = msgResult.rows as ChatMessage[];
      return { ...session, messages };
    },

    async updateTitle(id: string, title: string): Promise<boolean> {
      const now = new Date().toISOString();
      const result = await pool.query(SQL.updateTitle, [title, now, id]);
      return (result.rowCount ?? 0) > 0;
    },

    async addMessage(sessionId, role, text) {
      // Auto-create session if it doesn't exist
      const existsResult = await pool.query(SQL.sessionExists, [sessionId]);
      if (existsResult.rows.length === 0) {
        await store.create(sessionId);
      }

      const now = new Date().toISOString();
      const result = await pool.query(SQL.insertMessage, [sessionId, role, text, now]);

      // Touch the session's updated_at
      await pool.query(SQL.touchSession, [now, sessionId]);

      return {
        id: Number(result.rows[0].id),
        role,
        text,
        createdAt: now,
      };
    },

    async delete(id: string): Promise<boolean> {
      const result = await pool.query(SQL.deleteSession, [id]);
      return (result.rowCount ?? 0) > 0;
    },

    async touch(id: string): Promise<void> {
      const now = new Date().toISOString();
      await pool.query(SQL.touchSession, [now, id]);
    },

    async count(): Promise<number> {
      const result = await pool.query(SQL.countSessions);
      return Number((result.rows[0] as { count: string | number }).count);
    },

    close(): void {
      // Pool lifecycle managed externally
    },
  };

  return store;
}
