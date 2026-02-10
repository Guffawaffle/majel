/**
 * sessions.ts — Chat Session Store
 *
 * Majel — STFC Fleet Intelligence System
 *
 * libSQL-backed local chat history. Each session stores its full
 * message log so users can browse and restore past conversations.
 *
 * Migrated from better-sqlite3 to @libsql/client in ADR-018 Phase 1.
 */

import { openDatabase, initSchema, type Client } from "./db.js";
import * as path from "node:path";
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
  getDbPath(): string;
  count(): Promise<number>;
  close(): void;
}

// ─── SQL ────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'model', 'system', 'error')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id, created_at)`,
];

const SQL = {
  insertSession: `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  getSession: `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?`,
  listSessions: `SELECT
    s.id,
    s.title,
    s.created_at AS createdAt,
    s.updated_at AS updatedAt,
    COUNT(m.id) AS messageCount,
    (SELECT text FROM messages
     WHERE session_id = s.id AND role = 'user'
     ORDER BY created_at ASC LIMIT 1) AS preview
  FROM sessions s
  LEFT JOIN messages m ON m.session_id = s.id
  GROUP BY s.id
  ORDER BY s.updated_at DESC
  LIMIT ?`,
  updateTitle: `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
  touchSession: `UPDATE sessions SET updated_at = ? WHERE id = ?`,
  deleteSession: `DELETE FROM sessions WHERE id = ?`,
  insertMessage: `INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)`,
  getMessages: `SELECT id, role, text, created_at AS createdAt FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
  countSessions: `SELECT COUNT(*) AS count FROM sessions`,
  sessionExists: `SELECT 1 FROM sessions WHERE id = ?`,
};

// ─── Implementation ─────────────────────────────────────────

const DB_DIR = path.resolve(".smartergpt", "lex");
const DB_FILE = path.join(DB_DIR, "chat.db");

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

export async function createSessionStore(dbPath?: string): Promise<SessionStore> {
  const resolvedPath = dbPath || DB_FILE;
  const client = openDatabase(resolvedPath);
  await initSchema(client, SCHEMA_STATEMENTS);

  log.boot.debug({ dbPath: resolvedPath }, "session store initialized");

  const store: SessionStore = {
    async create(id: string, title?: string): Promise<ChatSession> {
      const now = new Date().toISOString();
      const resolvedTitle = title || generateTimestampTitle();
      await client.execute({ sql: SQL.insertSession, args: [id, resolvedTitle, now, now] });
      log.settings.debug({ id, title: resolvedTitle }, "session created");
      return { id, title: resolvedTitle, createdAt: now, updatedAt: now };
    },

    async list(limit = 50): Promise<SessionSummary[]> {
      const result = await client.execute({ sql: SQL.listSessions, args: [limit] });
      return result.rows as unknown as SessionSummary[];
    },

    async get(id: string) {
      const sessionResult = await client.execute({ sql: SQL.getSession, args: [id] });
      const session = sessionResult.rows[0] as unknown as ChatSession | undefined;
      if (!session) return null;
      const msgResult = await client.execute({ sql: SQL.getMessages, args: [id] });
      const messages = msgResult.rows as unknown as ChatMessage[];
      return { ...session, messages };
    },

    async updateTitle(id: string, title: string): Promise<boolean> {
      const now = new Date().toISOString();
      const result = await client.execute({ sql: SQL.updateTitle, args: [title, now, id] });
      return result.rowsAffected > 0;
    },

    async addMessage(sessionId, role, text) {
      // Auto-create session if it doesn't exist
      const existsResult = await client.execute({ sql: SQL.sessionExists, args: [sessionId] });
      if (existsResult.rows.length === 0) {
        await store.create(sessionId);
      }

      const now = new Date().toISOString();
      const result = await client.execute({ sql: SQL.insertMessage, args: [sessionId, role, text, now] });

      // Touch the session's updated_at
      await client.execute({ sql: SQL.touchSession, args: [now, sessionId] });

      return {
        id: Number(result.lastInsertRowid),
        role,
        text,
        createdAt: now,
      };
    },

    async delete(id: string): Promise<boolean> {
      const result = await client.execute({ sql: SQL.deleteSession, args: [id] });
      return result.rowsAffected > 0;
    },

    async touch(id: string): Promise<void> {
      const now = new Date().toISOString();
      await client.execute({ sql: SQL.touchSession, args: [now, id] });
    },

    getDbPath(): string {
      return resolvedPath;
    },

    async count(): Promise<number> {
      const result = await client.execute(SQL.countSessions);
      return (result.rows[0] as unknown as { count: number }).count;
    },

    close(): void {
      client.close();
    },
  };

  return store;
}
