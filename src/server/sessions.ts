/**
 * sessions.ts — Chat Session Store
 *
 * Majel — STFC Fleet Intelligence System
 *
 * SQLite-backed local chat history. Each session stores its full
 * message log so users can browse and restore past conversations.
 *
 * Titles are timestamp-based on creation (YYYYMMDD-HHmmss) and
 * dynamically updatable — future versions can auto-summarize.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
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
  /** Create a new session. Returns the created session. */
  create(id: string, title?: string): ChatSession;

  /** List all sessions, most recent first. */
  list(limit?: number): SessionSummary[];

  /** Get a session by ID with all messages. Returns null if not found. */
  get(id: string): (ChatSession & { messages: ChatMessage[] }) | null;

  /** Update session title. Returns true if updated. */
  updateTitle(id: string, title: string): boolean;

  /** Add a message to a session. Auto-creates session if needed. */
  addMessage(
    sessionId: string,
    role: ChatMessage["role"],
    text: string,
  ): ChatMessage;

  /** Delete a session and its messages. Returns true if deleted. */
  delete(id: string): boolean;

  /** Touch the updated_at timestamp (called on every interaction). */
  touch(id: string): void;

  /** Get the DB path (for diagnostics). */
  getDbPath(): string;

  /** Count total sessions. */
  count(): number;

  /** Close the database. */
  close(): void;
}

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

export function createSessionStore(dbPath?: string): SessionStore {
  const resolvedPath = dbPath || DB_FILE;

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ── Schema ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'model', 'system', 'error')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, created_at);
  `);

  log.boot.debug({ dbPath: resolvedPath }, "session store initialized");

  // ── Prepared statements ─────────────────────────────────
  const stmts = {
    insertSession: db.prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ),

    getSession: db.prepare(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
       FROM sessions WHERE id = ?`,
    ),

    listSessions: db.prepare(
      `SELECT
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
    ),

    updateTitle: db.prepare(
      `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
    ),

    touchSession: db.prepare(
      `UPDATE sessions SET updated_at = ? WHERE id = ?`,
    ),

    deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),

    insertMessage: db.prepare(
      `INSERT INTO messages (session_id, role, text, created_at)
       VALUES (?, ?, ?, ?)`,
    ),

    getMessages: db.prepare(
      `SELECT id, role, text, created_at AS createdAt
       FROM messages WHERE session_id = ?
       ORDER BY created_at ASC`,
    ),

    countSessions: db.prepare(`SELECT COUNT(*) AS count FROM sessions`),

    sessionExists: db.prepare(`SELECT 1 FROM sessions WHERE id = ?`),
  };

  // ── Store object ────────────────────────────────────────
  const store: SessionStore = {
    create(id: string, title?: string): ChatSession {
      const now = new Date().toISOString();
      const resolvedTitle = title || generateTimestampTitle();
      stmts.insertSession.run(id, resolvedTitle, now, now);
      log.settings.debug({ id, title: resolvedTitle }, "session created");
      return { id, title: resolvedTitle, createdAt: now, updatedAt: now };
    },

    list(limit = 50): SessionSummary[] {
      return stmts.listSessions.all(limit) as SessionSummary[];
    },

    get(id: string) {
      const session = stmts.getSession.get(id) as ChatSession | undefined;
      if (!session) return null;
      const messages = stmts.getMessages.all(id) as ChatMessage[];
      return { ...session, messages };
    },

    updateTitle(id: string, title: string): boolean {
      const now = new Date().toISOString();
      const result = stmts.updateTitle.run(title, now, id);
      return result.changes > 0;
    },

    addMessage(sessionId, role, text) {
      // Auto-create session if it doesn't exist
      const exists = stmts.sessionExists.get(sessionId);
      if (!exists) {
        store.create(sessionId);
      }

      const now = new Date().toISOString();
      const result = stmts.insertMessage.run(sessionId, role, text, now);

      // Touch the session's updated_at
      stmts.touchSession.run(now, sessionId);

      return {
        id: Number(result.lastInsertRowid),
        role,
        text,
        createdAt: now,
      };
    },

    delete(id: string): boolean {
      const result = stmts.deleteSession.run(id);
      return result.changes > 0;
    },

    touch(id: string): void {
      const now = new Date().toISOString();
      stmts.touchSession.run(now, id);
    },

    getDbPath(): string {
      return resolvedPath;
    },

    count(): number {
      const row = stmts.countSessions.get() as { count: number };
      return row.count;
    },

    close(): void {
      db.close();
    },
  };

  return store;
}
