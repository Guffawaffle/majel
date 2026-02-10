/**
 * db.ts — Database connection helper (ADR-018 Phase 1)
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Thin wrapper around @libsql/client for creating database connections.
 * Uses file: URLs in local mode, libsql: URLs for Turso cloud.
 *
 * Pattern:
 *   const client = openDatabase("/path/to/db.db");
 *   await initSchema(client, [...statements]);
 *   // ...use client.execute(), client.batch(), client.transaction()...
 *   client.close();
 */

import { createClient, type Client, type InStatement, type ResultSet, type Transaction } from "@libsql/client";
import * as fs from "node:fs";
import * as path from "node:path";

export type { Client, ResultSet, Transaction, InStatement };

/**
 * Open a database connection.
 *
 * @param dbPath — File path (e.g. "data/behavior.db") or URL (e.g. "libsql://...").
 *                 File paths are automatically converted to file: URLs.
 *                 Directories are created if they don't exist.
 * @param opts   — Optional: { authToken } for Turso cloud connections.
 */
export function openDatabase(
  dbPath: string,
  opts?: { authToken?: string },
): Client {
  let url: string;

  if (dbPath.startsWith("libsql://") || dbPath.startsWith("file:")) {
    url = dbPath;
  } else {
    // Local file path — ensure directory exists, convert to file: URL
    const resolved = path.resolve(dbPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    url = `file:${resolved}`;
  }

  return createClient({
    url,
    authToken: opts?.authToken,
  });
}

/**
 * Initialize database schema from an array of SQL statements.
 * Runs as a write batch (atomic). Also enables foreign keys and WAL mode.
 * WAL must be set outside the transaction since SQLite forbids mode changes mid-txn.
 */
export async function initSchema(
  client: Client,
  statements: string[],
): Promise<void> {
  // WAL and busy_timeout must run outside any transaction
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA busy_timeout = 5000");
  const batch: string[] = [
    "PRAGMA foreign_keys = ON",
    ...statements,
  ];
  await client.batch(batch, "write");
}

/**
 * Split a multi-statement SQL string into individual statements.
 * Useful for porting existing SCHEMA constants.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
