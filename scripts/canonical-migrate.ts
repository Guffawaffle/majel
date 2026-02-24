#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

interface MigrationFile {
  version: string;
  fileName: string;
  fullPath: string;
  sql: string;
  checksum: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function parseFlag(args: string[], flag: string): string | undefined {
  const exact = args.findIndex((arg) => arg === flag);
  if (exact >= 0) {
    const next = args[exact + 1];
    if (next && !next.startsWith("--")) return next;
  }
  const prefix = `${flag}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function loadMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const migrations: MigrationFile[] = [];
  for (const fileName of sqlFiles) {
    const version = fileName.split("_")[0] ?? fileName;
    const fullPath = join(migrationsDir, fileName);
    const sql = await readFile(fullPath, "utf8");
    migrations.push({
      version,
      fileName,
      fullPath,
      sql,
      checksum: sha256(sql),
    });
  }
  return migrations;
}

async function ensureLedgerTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical_schema_migrations (
      version TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function status(pool: pg.Pool, migrations: MigrationFile[]): Promise<void> {
  await ensureLedgerTable(pool);
  const result = await pool.query<{
    version: string;
    file_name: string;
    checksum: string;
    applied_at: string;
  }>(`SELECT version, file_name, checksum, applied_at FROM canonical_schema_migrations ORDER BY version ASC`);

  const appliedMap = new Map(result.rows.map((row) => [row.version, row]));
  const pending = migrations.filter((migration) => !appliedMap.has(migration.version));

  const payload = {
    appliedCount: result.rows.length,
    pendingCount: pending.length,
    applied: result.rows,
    pending: pending.map((migration) => ({
      version: migration.version,
      fileName: migration.fileName,
      checksum: migration.checksum,
    })),
  };

  console.log(JSON.stringify(payload, null, 2));
}

async function applyMigrations(pool: pg.Pool, migrations: MigrationFile[]): Promise<void> {
  await ensureLedgerTable(pool);

  for (const migration of migrations) {
    const existing = await pool.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM canonical_schema_migrations WHERE version = $1`,
      [migration.version]
    );

    if (existing.rowCount && existing.rows[0]) {
      if (existing.rows[0].checksum !== migration.checksum) {
        throw new Error(
          `Migration checksum mismatch for ${migration.version}: ledger=${existing.rows[0].checksum} file=${migration.checksum}`
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO canonical_schema_migrations (version, file_name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.fileName, migration.checksum]
      );
      await client.query("COMMIT");
      console.log(`applied ${migration.version} (${migration.fileName})`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbUrl = parseFlag(args, "--db-url") ?? process.env.DATABASE_URL ?? "postgres://majel:majel@localhost:5432/majel";
  const migrationsDir = parseFlag(args, "--migrations-dir") ?? resolve("migrations", "canonical");
  const showStatus = hasFlag(args, "--status");

  const migrations = await loadMigrationFiles(migrationsDir);
  if (migrations.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`);
  }

  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    if (showStatus) {
      await status(pool, migrations);
      return;
    }
    await applyMigrations(pool, migrations);
    await status(pool, migrations);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
