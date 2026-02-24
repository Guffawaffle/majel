#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import pg from "pg";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

const CANONICAL_RUNTIME_SCOPE = "canonical-global";
const CANONICAL_DATASET_KIND = "canonical";

interface FeedManifest {
  schemaVersion: string;
  datasetKind?: string;
  feedId: string;
  runId: string;
  schemaHash: string;
  sourceLabel: string;
  sourceVersion: string | null;
  snapshotId: string | null;
  generatedAt: string;
  contentHash: string;
  artifactUri?: string;
  artifactFormat?: string;
  hashSemantics?: string;
  artifactAvailability?: {
    status?: "available" | "unavailable";
    reason?: string;
    prunedAt?: string;
  };
  metrics?: JsonValue;
  entityCounts: Record<string, number>;
  entityHashes: Record<string, string>;
  entityFiles: Record<string, string>;
  producer: {
    name: string;
    version: string;
  };
}

interface EntityFile {
  schemaVersion: string;
  entityType: string;
  generatedAt: string;
  count: number;
  hash: string;
  records: JsonValue[];
}

interface ValidatedFeed {
  feedPath: string;
  manifest: FeedManifest;
  entityFiles: Record<string, EntityFile>;
  errors: string[];
}

interface PreparedEntityRecords {
  entityType: string;
  records: Array<{
    naturalKey: string;
    payload: JsonValue;
  }>;
}

interface OrphanViolation {
  entityType: string;
  naturalKey: string;
  field: string;
  referencedEntityType: string;
  referencedNaturalKey: string;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const index = args.findIndex((value) => value === flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parsePositiveIntFlag(args: string[], flag: string): number | undefined {
  const raw = parseFlag(args, flag);
  if (raw == null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} must be an integer >= 1`);
  }
  return parsed;
}

function toObject(value: JsonValue): JsonObject | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return undefined;
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const output: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = canonicalize((value as JsonObject)[key]);
  }
  return output;
}

function stableJsonStringify(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function stableSortObject<T>(input: Record<string, T>): Record<string, T> {
  const output: Record<string, T> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = input[key];
  }
  return output;
}

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function extractNaturalKey(entityType: string, record: JsonValue): string | undefined {
  const obj = toObject(record);
  if (!obj) return undefined;

  if (entityType.startsWith("translation.")) {
    const locale = typeof obj.locale === "string" ? obj.locale : "";
    const namespace = typeof obj.namespace === "string" ? obj.namespace : "";
    const translationKey = typeof obj.translation_key === "string" ? obj.translation_key : "";
    if (!locale || !namespace || !translationKey) return undefined;
    return `${locale}:${namespace}:${translationKey}`;
  }

  const gameId = obj.game_id;
  if (typeof gameId === "number") return String(gameId);
  if (typeof gameId === "string" && gameId.trim().length > 0) return gameId;
  return undefined;
}

function computeContentHashBasis(manifest: FeedManifest): JsonValue {
  return {
    schemaVersion: manifest.schemaVersion,
    sourceLabel: manifest.sourceLabel,
    sourceVersion: manifest.sourceVersion ?? null,
    snapshotId: manifest.snapshotId ?? null,
    entityHashes: stableSortObject(manifest.entityHashes),
    entityCounts: stableSortObject(manifest.entityCounts),
  };
}

function entityLeaf(entityType: string): string {
  const parts = entityType.split(".");
  return parts[parts.length - 1] ?? entityType;
}

function pluralForms(input: string): Set<string> {
  const values = new Set<string>();
  const lower = input.toLowerCase();
  values.add(lower);
  if (lower.endsWith("ies") && lower.length > 3) {
    values.add(`${lower.slice(0, -3)}y`);
  }
  if (lower.endsWith("s") && lower.length > 1) {
    values.add(lower.slice(0, -1));
  } else {
    values.add(`${lower}s`);
    values.add(`${lower}es`);
  }
  return values;
}

function findOrphanViolations(entities: PreparedEntityRecords[]): OrphanViolation[] {
  const gameplayEntities = entities.filter((entity) => entity.entityType.startsWith("stfc.gameplay."));
  const referenceIndex = new Map<string, Set<string>>();

  for (const entity of gameplayEntities) {
    referenceIndex.set(entity.entityType, new Set(entity.records.map((record) => record.naturalKey)));
  }

  const aliasToEntityTypes = new Map<string, string[]>();
  for (const entity of gameplayEntities) {
    const aliases = pluralForms(entityLeaf(entity.entityType));
    for (const alias of aliases) {
      const existing = aliasToEntityTypes.get(alias) ?? [];
      if (!existing.includes(entity.entityType)) {
        existing.push(entity.entityType);
      }
      aliasToEntityTypes.set(alias, existing.sort());
    }
  }

  const violations: OrphanViolation[] = [];
  for (const entity of gameplayEntities) {
    for (const record of entity.records) {
      const payload = toObject(record.payload);
      if (!payload) continue;

      for (const [field, value] of Object.entries(payload)) {
        if (!field.endsWith("_id") || field === "game_id") continue;

        const keyAlias = field.slice(0, -3).toLowerCase();
        const targetTypes = aliasToEntityTypes.get(keyAlias);
        if (!targetTypes || targetTypes.length !== 1) continue;

        const referencedEntityType = targetTypes[0]!;
        const referencedSet = referenceIndex.get(referencedEntityType);
        if (!referencedSet || referencedSet.size === 0) continue;

        const referencedNaturalKey =
          typeof value === "number"
            ? String(value)
            : typeof value === "string"
              ? value.trim()
              : "";
        if (!referencedNaturalKey) continue;

        if (!referencedSet.has(referencedNaturalKey)) {
          violations.push({
            entityType: entity.entityType,
            naturalKey: record.naturalKey,
            field,
            referencedEntityType,
            referencedNaturalKey,
          });
        }
      }
    }
  }

  return violations.sort((a, b) => {
    const left = `${a.entityType}:${a.naturalKey}:${a.field}:${a.referencedEntityType}:${a.referencedNaturalKey}`;
    const right = `${b.entityType}:${b.naturalKey}:${b.field}:${b.referencedEntityType}:${b.referencedNaturalKey}`;
    return left.localeCompare(right);
  });
}

async function resolveFeedPath(feedsRoot: string, feedOrPath: string): Promise<string> {
  const direct = resolve(feedOrPath);
  try {
    const details = await stat(direct);
    if (details.isDirectory()) {
      await stat(join(direct, "feed.json"));
      return direct;
    }
  } catch {
    // no-op
  }

  const feedRoot = resolve(feedsRoot, feedOrPath);
  try {
    const details = await stat(feedRoot);
    if (details.isDirectory()) {
      await stat(join(feedRoot, "feed.json"));
      return feedRoot;
    }
  } catch {
    // no-op
  }

  const runCandidates = await (await import("node:fs/promises")).readdir(feedRoot, { withFileTypes: true });
  const runDirs = runCandidates.filter((entry) => entry.isDirectory()).map((entry) => join(feedRoot, entry.name));
  if (runDirs.length === 0) {
    throw new Error(`No feed runs found for '${feedOrPath}' in ${feedsRoot}`);
  }

  const stats = await Promise.all(runDirs.map(async (path) => ({ path, stat: await stat(path) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0]?.path ?? runDirs[0]!;
}

async function validateFeed(feedPathInput: string, feedsRoot: string): Promise<ValidatedFeed> {
  const errors: string[] = [];
  const feedPath = await resolveFeedPath(feedsRoot, feedPathInput);
  const manifestRaw = await readFile(join(feedPath, "feed.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as FeedManifest;

  const requiredManifestKeys = [
    "schemaVersion",
    "feedId",
    "runId",
    "schemaHash",
    "sourceLabel",
    "sourceVersion",
    "snapshotId",
    "generatedAt",
    "contentHash",
    "entityCounts",
    "entityHashes",
    "entityFiles",
    "producer",
  ];

  for (const key of requiredManifestKeys) {
    if (!hasOwn(manifest as unknown as object, key)) {
      errors.push(`manifest missing required key '${key}'`);
    }
  }

  if (manifest.schemaVersion !== "1.0.0") {
    errors.push(`manifest schemaVersion mismatch: expected 1.0.0, got ${manifest.schemaVersion}`);
  }

  if (manifest.sourceVersion !== null && typeof manifest.sourceVersion !== "string") {
    errors.push("manifest sourceVersion must be string or null");
  }
  if (manifest.snapshotId !== null && typeof manifest.snapshotId !== "string") {
    errors.push("manifest snapshotId must be string or null");
  }

  const entityFiles: Record<string, EntityFile> = {};

  for (const [entityType, relativePath] of Object.entries(manifest.entityFiles ?? {})) {
    const fileRaw = await readFile(join(feedPath, relativePath), "utf8");
    const entityFile = JSON.parse(fileRaw) as EntityFile;
    entityFiles[entityType] = entityFile;

    if (!Array.isArray(entityFile.records)) {
      errors.push(`${entityType}: records must be an array`);
      continue;
    }

    const recomputedHash = sha256Hex(stableJsonStringify(entityFile.records));
    if (entityFile.hash !== recomputedHash) {
      errors.push(`${entityType}: entity hash mismatch`);
    }
    if (manifest.entityHashes[entityType] !== recomputedHash) {
      errors.push(`${entityType}: manifest hash mismatch`);
    }
    if (entityFile.count !== entityFile.records.length) {
      errors.push(`${entityType}: entity file count mismatch`);
    }
    if (manifest.entityCounts[entityType] !== entityFile.records.length) {
      errors.push(`${entityType}: manifest count mismatch`);
    }

    const naturalKeys = new Set<string>();
    for (let index = 0; index < entityFile.records.length; index += 1) {
      const record = entityFile.records[index];
      const key = extractNaturalKey(entityType, record);

      if (entityType.startsWith("translation.")) {
        const obj = toObject(record);
        const hasNamespace = typeof obj?.namespace === "string";
        const hasKey = typeof obj?.translation_key === "string";
        const hasText = typeof obj?.translation_text === "string";
        if (!hasNamespace || !hasKey || !hasText) {
          errors.push(`${entityType}: record[${index}] missing translation identity fields`);
          continue;
        }
      } else if (!key) {
        errors.push(`${entityType}: record[${index}] missing required key 'game_id'`);
        continue;
      }

      if (key) {
        if (naturalKeys.has(key)) {
          errors.push(`${entityType}: duplicate natural key '${key}'`);
        }
        naturalKeys.add(key);
      }
    }
  }

  let recomputedContentHash = sha256Hex(stableJsonStringify(computeContentHashBasis(manifest)));
  if (
    manifest.hashSemantics === "sha256:utf8-bytes:raw-artifact"
    && typeof manifest.artifactUri === "string"
    && manifest.artifactUri.length > 0
  ) {
    const artifactRaw = await readFile(join(feedPath, manifest.artifactUri), "utf8");
    recomputedContentHash = sha256Hex(artifactRaw);
  }
  if (manifest.contentHash !== recomputedContentHash) {
    errors.push("manifest contentHash mismatch");
  }

  return { feedPath, manifest, entityFiles, errors };
}

async function ensureIngestionSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS canonical`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.factions (
      id BIGSERIAL PRIMARY KEY,
      faction_game_id BIGINT NOT NULL UNIQUE,
      loca_id BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.resources (
      id BIGSERIAL PRIMARY KEY,
      resource_game_id BIGINT NOT NULL UNIQUE,
      resource_type TEXT,
      grade INTEGER,
      loca_id BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.translations (
      id BIGSERIAL PRIMARY KEY,
      locale TEXT NOT NULL DEFAULT 'en',
      namespace TEXT NOT NULL,
      translation_key TEXT NOT NULL,
      translation_text TEXT NOT NULL,
      translation_external_id TEXT,
      UNIQUE (locale, namespace, translation_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.asset_refs (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id BIGINT NOT NULL,
      art_id BIGINT,
      loca_id BIGINT,
      UNIQUE (entity_type, entity_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.officers (
      id BIGSERIAL PRIMARY KEY,
      officer_game_id BIGINT NOT NULL UNIQUE,
      faction_id BIGINT REFERENCES canonical.factions(id),
      rarity INTEGER,
      officer_class INTEGER,
      synergy_game_id BIGINT,
      max_rank INTEGER,
      is_active BOOLEAN NOT NULL DEFAULT true
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.officer_levels (
      id BIGSERIAL PRIMARY KEY,
      officer_id BIGINT NOT NULL REFERENCES canonical.officers(id) ON DELETE CASCADE,
      level_number INTEGER NOT NULL,
      xp_required BIGINT,
      UNIQUE (officer_id, level_number)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.officer_level_resources (
      id BIGSERIAL PRIMARY KEY,
      officer_level_id BIGINT NOT NULL REFERENCES canonical.officer_levels(id) ON DELETE CASCADE,
      resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
      amount BIGINT NOT NULL CHECK (amount >= 0),
      UNIQUE (officer_level_id, resource_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.ships (
      id BIGSERIAL PRIMARY KEY,
      ship_game_id BIGINT NOT NULL UNIQUE,
      faction_id BIGINT REFERENCES canonical.factions(id),
      hull_type TEXT,
      ship_class TEXT,
      grade INTEGER,
      rarity INTEGER,
      max_tier INTEGER,
      max_level INTEGER,
      blueprints_required BIGINT,
      build_time_in_seconds BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.ship_levels (
      id BIGSERIAL PRIMARY KEY,
      ship_id BIGINT NOT NULL REFERENCES canonical.ships(id) ON DELETE CASCADE,
      level_number INTEGER NOT NULL,
      xp_required BIGINT,
      shield BIGINT,
      health BIGINT,
      UNIQUE (ship_id, level_number)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.ship_build_costs (
      id BIGSERIAL PRIMARY KEY,
      ship_id BIGINT NOT NULL REFERENCES canonical.ships(id) ON DELETE CASCADE,
      resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
      amount BIGINT NOT NULL CHECK (amount >= 0),
      UNIQUE (ship_id, resource_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.ship_repair_costs (
      id BIGSERIAL PRIMARY KEY,
      ship_id BIGINT NOT NULL REFERENCES canonical.ships(id) ON DELETE CASCADE,
      resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
      amount BIGINT NOT NULL CHECK (amount >= 0),
      UNIQUE (ship_id, resource_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.research_trees (
      id BIGSERIAL PRIMARY KEY,
      tree_game_id BIGINT NOT NULL UNIQUE,
      loca_id BIGINT,
      tree_type TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.research_nodes (
      id BIGSERIAL PRIMARY KEY,
      research_game_id BIGINT NOT NULL UNIQUE,
      research_tree_id BIGINT REFERENCES canonical.research_trees(id) ON DELETE SET NULL,
      row_num INTEGER,
      column_num INTEGER,
      unlock_level INTEGER,
      view_level INTEGER,
      max_level INTEGER,
      generation INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.research_buffs (
      id BIGSERIAL PRIMARY KEY,
      research_node_id BIGINT NOT NULL REFERENCES canonical.research_nodes(id) ON DELETE CASCADE,
      buff_game_id BIGINT NOT NULL,
      value_is_percentage BOOLEAN,
      show_percentage BOOLEAN,
      value_type TEXT,
      UNIQUE (research_node_id, buff_game_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.research_buff_levels (
      id BIGSERIAL PRIMARY KEY,
      research_buff_id BIGINT NOT NULL REFERENCES canonical.research_buffs(id) ON DELETE CASCADE,
      level_number INTEGER NOT NULL,
      value_numeric DOUBLE PRECISION,
      UNIQUE (research_buff_id, level_number)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.research_levels (
      id BIGSERIAL PRIMARY KEY,
      research_node_id BIGINT NOT NULL REFERENCES canonical.research_nodes(id) ON DELETE CASCADE,
      level_number INTEGER NOT NULL,
      research_time_seconds BIGINT,
      hard_currency_cost BIGINT,
      UNIQUE (research_node_id, level_number)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.research_level_resources (
      id BIGSERIAL PRIMARY KEY,
      research_level_id BIGINT NOT NULL REFERENCES canonical.research_levels(id) ON DELETE CASCADE,
      resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
      amount BIGINT NOT NULL CHECK (amount >= 0),
      UNIQUE (research_level_id, resource_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.research_requirements (
      id BIGSERIAL PRIMARY KEY,
      research_level_id BIGINT NOT NULL REFERENCES canonical.research_levels(id) ON DELETE CASCADE,
      requirement_type TEXT NOT NULL,
      requirement_external_id TEXT,
      requirement_level INTEGER,
      UNIQUE (research_level_id, requirement_type, requirement_external_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.research_rewards (
      id BIGSERIAL PRIMARY KEY,
      research_level_id BIGINT NOT NULL REFERENCES canonical.research_levels(id) ON DELETE CASCADE,
      reward_type TEXT NOT NULL,
      reward_external_id TEXT,
      amount BIGINT,
      UNIQUE (research_level_id, reward_type, reward_external_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.buildings (
      id BIGSERIAL PRIMARY KEY,
      building_game_id BIGINT NOT NULL UNIQUE,
      section TEXT,
      max_level INTEGER,
      unlock_level INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.building_buffs (
      id BIGSERIAL PRIMARY KEY,
      building_id BIGINT NOT NULL REFERENCES canonical.buildings(id) ON DELETE CASCADE,
      buff_game_id BIGINT NOT NULL,
      UNIQUE (building_id, buff_game_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.building_buff_levels (
      id BIGSERIAL PRIMARY KEY,
      building_buff_id BIGINT NOT NULL REFERENCES canonical.building_buffs(id) ON DELETE CASCADE,
      level_number INTEGER NOT NULL,
      value_numeric DOUBLE PRECISION,
      UNIQUE (building_buff_id, level_number)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.building_levels (
      id BIGSERIAL PRIMARY KEY,
      building_id BIGINT NOT NULL REFERENCES canonical.buildings(id) ON DELETE CASCADE,
      level_number INTEGER NOT NULL,
      build_time_seconds BIGINT,
      strength BIGINT,
      strength_increase BIGINT,
      UNIQUE (building_id, level_number)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.building_level_resources (
      id BIGSERIAL PRIMARY KEY,
      building_level_id BIGINT NOT NULL REFERENCES canonical.building_levels(id) ON DELETE CASCADE,
      resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
      amount BIGINT NOT NULL CHECK (amount >= 0),
      UNIQUE (building_level_id, resource_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.building_requirements (
      id BIGSERIAL PRIMARY KEY,
      building_level_id BIGINT NOT NULL REFERENCES canonical.building_levels(id) ON DELETE CASCADE,
      requirement_type TEXT NOT NULL,
      requirement_external_id TEXT,
      requirement_level INTEGER,
      UNIQUE (building_level_id, requirement_type, requirement_external_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.systems (
      id BIGSERIAL PRIMARY KEY,
      system_game_id BIGINT NOT NULL UNIQUE,
      level INTEGER,
      coords_x INTEGER,
      coords_y INTEGER,
      est_warp INTEGER,
      est_warp_with_superhighways INTEGER,
      is_deep_space BOOLEAN,
      is_mirror_universe BOOLEAN,
      is_wave_defense BOOLEAN,
      is_surge_system BOOLEAN,
      is_regional_space BOOLEAN,
      hazards_enabled BOOLEAN,
      hazard_level INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.system_factions (
      id BIGSERIAL PRIMARY KEY,
      system_id BIGINT NOT NULL REFERENCES canonical.systems(id) ON DELETE CASCADE,
      faction_id BIGINT NOT NULL REFERENCES canonical.factions(id),
      UNIQUE (system_id, faction_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.system_mines (
      id BIGSERIAL PRIMARY KEY,
      system_id BIGINT NOT NULL REFERENCES canonical.systems(id) ON DELETE CASCADE,
      mine_game_id BIGINT,
      resource_id BIGINT REFERENCES canonical.resources(id),
      rate BIGINT,
      amount BIGINT,
      coords_x INTEGER,
      coords_y INTEGER,
      UNIQUE (system_id, mine_game_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.system_planets (
      id BIGSERIAL PRIMARY KEY,
      system_id BIGINT NOT NULL REFERENCES canonical.systems(id) ON DELETE CASCADE,
      planet_game_id BIGINT,
      coords_x INTEGER,
      coords_y INTEGER,
      slots INTEGER,
      UNIQUE (system_id, planet_game_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical.system_missions (
      id BIGSERIAL PRIMARY KEY,
      system_id BIGINT NOT NULL REFERENCES canonical.systems(id) ON DELETE CASCADE,
      mission_game_id BIGINT NOT NULL,
      UNIQUE (system_id, mission_game_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical_ingestion_records (
      entity_type TEXT NOT NULL,
      natural_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      source_label TEXT NOT NULL,
      feed_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (entity_type, natural_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS canonical_ingestion_runs (
      id BIGSERIAL PRIMARY KEY,
      feed_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      feed_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_label TEXT NOT NULL,
      source_version TEXT,
      snapshot_id TEXT,
      status TEXT NOT NULL,
      validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      entity_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      orphan_count INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_ingestion_runs_feed_run
    ON canonical_ingestion_runs(feed_id, run_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS effect_dataset_run (
      run_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL UNIQUE,
      dataset_kind TEXT NOT NULL,
      source_label TEXT NOT NULL,
      source_version TEXT,
      snapshot_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('staged', 'active', 'retired', 'failed')),
      metrics_json TEXT,
      metadata_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS effect_dataset_active (
      scope TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES effect_dataset_run(run_id) ON DELETE RESTRICT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_effect_dataset_run_status_created
    ON effect_dataset_run(status, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_effect_dataset_run_created
    ON effect_dataset_run(created_at DESC)
  `);
}

function compareRecordsByNaturalKey(entityType: string, a: JsonValue[], b: JsonValue[]): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const aMap = new Map<string, string>();
  const bMap = new Map<string, string>();

  for (const record of a) {
    const key = extractNaturalKey(entityType, record);
    if (!key) continue;
    aMap.set(key, sha256Hex(stableJsonStringify(record)));
  }
  for (const record of b) {
    const key = extractNaturalKey(entityType, record);
    if (!key) continue;
    bMap.set(key, sha256Hex(stableJsonStringify(record)));
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  const keys = new Set([...aMap.keys(), ...bMap.keys()]);
  for (const key of [...keys].sort()) {
    const av = aMap.get(key);
    const bv = bMap.get(key);
    if (av == null && bv != null) {
      added.push(key);
      continue;
    }
    if (av != null && bv == null) {
      removed.push(key);
      continue;
    }
    if (av !== bv) {
      changed.push(key);
    }
  }

  return { added, removed, changed };
}

async function writeLoadReceipt(path: string, payload: JsonValue): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
}

async function cmdValidate(args: string[]): Promise<void> {
  const feed = parseFlag(args, "--feed");
  if (!feed) {
    throw new Error("validate requires --feed <feedId-or-path>");
  }
  const feedsRoot = parseFlag(args, "--feeds-root") ?? "data/feeds";

  const result = await validateFeed(feed, feedsRoot);
  if (result.errors.length > 0) {
    console.error(`❌ validation failed for ${result.feedPath}`);
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`✅ validation ok for ${result.feedPath}`);
  console.log(`feedId=${result.manifest.feedId} runId=${result.manifest.runId}`);
  console.log(`contentHash=${result.manifest.contentHash}`);
}

async function cmdLoad(args: string[]): Promise<void> {
  const feed = parseFlag(args, "--feed");
  if (!feed) {
    throw new Error("load requires --feed <feedId-or-path>");
  }
  const feedsRoot = parseFlag(args, "--feeds-root") ?? "data/feeds";
  const dbUrl = parseFlag(args, "--db-url") ?? process.env.DATABASE_URL ?? "postgres://majel:majel@localhost:5432/majel";
  const strict = !hasFlag(args, "--allow-partial");
  const activateRuntimeDataset = hasFlag(args, "--activate-runtime-dataset");
  const retentionKeepRuns = parsePositiveIntFlag(args, "--retention-keep-runs");

  const startedAt = Date.now();
  const validated = await validateFeed(feed, feedsRoot);
  const loadReceiptPath = join(validated.feedPath, "receipts", "load-receipt.json");

  if (validated.errors.length > 0) {
    const failedReceipt: JsonValue = {
      schemaVersion: "1.0.0",
      feedId: validated.manifest.feedId,
      runId: validated.manifest.runId,
      status: "failed",
      feedPath: validated.feedPath,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      integrity: {
        validationOk: false,
        errors: validated.errors,
      },
    };
    await writeLoadReceipt(loadReceiptPath, failedReceipt);
    console.error(`❌ load blocked by validation errors (${validated.errors.length})`);
    for (const error of validated.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const recordsByEntity: PreparedEntityRecords[] = Object.entries(validated.entityFiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([entityType, file]) => {
      const records = file.records
        .map((record) => ({
          naturalKey: extractNaturalKey(entityType, record),
          payload: record,
        }))
        .filter((entry): entry is { naturalKey: string; payload: JsonValue } => typeof entry.naturalKey === "string")
        .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
      return { entityType, records };
    });

  let inserted = 0;
  let updated = 0;
  let duplicateNaturalKeys = 0;
  let retentionRemovedRunIds: string[] = [];
  const orphanViolations = findOrphanViolations(recordsByEntity);
  const datasetKind = CANONICAL_DATASET_KIND;
  const runtimeMetadata: JsonObject = {
    feedPath: validated.feedPath,
    feedId: validated.manifest.feedId,
    runId: validated.manifest.runId,
    schemaVersion: validated.manifest.schemaVersion,
    schemaHash: validated.manifest.schemaHash,
    artifactUri: validated.manifest.artifactUri ?? null,
    artifactFormat: validated.manifest.artifactFormat ?? null,
    hashSemantics: validated.manifest.hashSemantics ?? null,
    artifactAvailability: validated.manifest.artifactAvailability ?? null,
  };

  const pool = new pg.Pool({ connectionString: dbUrl });
  let runId: number | null = null;

  try {
    await ensureIngestionSchema(pool);

    const existingSuccessful = await pool.query<{
      id: number;
      content_hash: string;
      status: string;
      inserted_count: number;
      updated_count: number;
      duplicate_count: number;
      orphan_count: number;
      completed_at: string | null;
    }>(
      `SELECT
         id,
         content_hash,
         status,
         inserted_count,
         updated_count,
         duplicate_count,
         orphan_count,
         completed_at
       FROM canonical_ingestion_runs
       WHERE feed_id = $1 AND run_id = $2
       ORDER BY id DESC
       LIMIT 1`,
      [validated.manifest.feedId, validated.manifest.runId]
    );

    const prior = existingSuccessful.rows[0] ?? null;
    if (prior && prior.status === "success" && prior.content_hash === validated.manifest.contentHash) {
      const completedAt = Date.now();
      const noOpReceipt: JsonValue = {
        schemaVersion: "1.0.0",
        feedId: validated.manifest.feedId,
        runId: validated.manifest.runId,
        status: "noop",
        reason: "idempotent_replay",
        feedPath: validated.feedPath,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - startedAt,
        sourceLabel: validated.manifest.sourceLabel,
        sourceVersion: validated.manifest.sourceVersion,
        snapshotId: validated.manifest.snapshotId,
        contentHash: validated.manifest.contentHash,
        entityCounts: stableSortObject(validated.manifest.entityCounts),
        priorRun: {
          id: prior.id,
          status: prior.status,
          completedAt: prior.completed_at,
          inserted: prior.inserted_count,
          updated: prior.updated_count,
          duplicateNaturalKeys: prior.duplicate_count,
          orphanViolations: prior.orphan_count,
        },
      };
      await writeLoadReceipt(loadReceiptPath, noOpReceipt);
      console.log(`✅ load no-op replay for ${validated.feedPath}`);
      console.log(`reason=idempotent_replay`);
      console.log(`loadReceipt=${loadReceiptPath}`);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const lockResult = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
        [`canonical-ingestion:${validated.manifest.feedId}:${validated.manifest.runId}`]
      );
      if (!lockResult.rows[0]?.acquired) {
        throw new Error("concurrent canonical load already in progress for this feed/run");
      }

      const runInsert = await client.query<{ id: number }>(
        `INSERT INTO canonical_ingestion_runs (
          feed_id, run_id, feed_path, content_hash, source_label,
          source_version, snapshot_id, status, validation_errors, entity_counts, started_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', '[]'::jsonb, $8::jsonb, NOW())
        ON CONFLICT (feed_id, run_id) DO UPDATE SET
          feed_path = EXCLUDED.feed_path,
          content_hash = EXCLUDED.content_hash,
          source_label = EXCLUDED.source_label,
          source_version = EXCLUDED.source_version,
          snapshot_id = EXCLUDED.snapshot_id,
          status = 'running',
          validation_errors = '[]'::jsonb,
          entity_counts = EXCLUDED.entity_counts,
          inserted_count = 0,
          updated_count = 0,
          duplicate_count = 0,
          orphan_count = 0,
          started_at = NOW(),
          completed_at = NULL
        RETURNING id`,
        [
          validated.manifest.feedId,
          validated.manifest.runId,
          validated.feedPath,
          validated.manifest.contentHash,
          validated.manifest.sourceLabel,
          validated.manifest.sourceVersion,
          validated.manifest.snapshotId,
          JSON.stringify(stableSortObject(validated.manifest.entityCounts)),
        ]
      );
      runId = runInsert.rows[0]?.id ?? null;

      await client.query(
        `INSERT INTO effect_dataset_run (
          run_id, content_hash, dataset_kind, source_label,
          source_version, snapshot_id, status, metrics_json, metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (run_id) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          dataset_kind = EXCLUDED.dataset_kind,
          source_label = EXCLUDED.source_label,
          source_version = EXCLUDED.source_version,
          snapshot_id = EXCLUDED.snapshot_id,
          status = EXCLUDED.status,
          metrics_json = EXCLUDED.metrics_json,
          metadata_json = EXCLUDED.metadata_json`,
        [
          validated.manifest.runId,
          validated.manifest.contentHash,
          datasetKind,
          validated.manifest.sourceLabel,
          validated.manifest.sourceVersion,
          validated.manifest.snapshotId,
          activateRuntimeDataset ? "active" : "staged",
          validated.manifest.metrics ? JSON.stringify(validated.manifest.metrics) : null,
          JSON.stringify(runtimeMetadata),
        ]
      );

      if (activateRuntimeDataset) {
        await client.query(
          `UPDATE effect_dataset_run
           SET status = 'retired'
           WHERE status = 'active'
             AND dataset_kind = $2
             AND run_id <> $1`,
          [validated.manifest.runId, CANONICAL_DATASET_KIND]
        );

        await client.query(
          `UPDATE effect_dataset_run
           SET status = 'active', activated_at = NOW()
           WHERE run_id = $1`,
          [validated.manifest.runId]
        );

        await client.query(
          `INSERT INTO effect_dataset_active (scope, run_id, updated_at)
           VALUES ($2, $1, NOW())
           ON CONFLICT (scope) DO UPDATE SET
             run_id = EXCLUDED.run_id,
             updated_at = NOW()`,
          [validated.manifest.runId, CANONICAL_RUNTIME_SCOPE]
        );
      }

      if (retentionKeepRuns != null) {
        const retentionResult = await client.query<{ run_id: string }>(
          `WITH ranked AS (
             SELECT run_id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
             FROM effect_dataset_run
             WHERE dataset_kind = $2
           ),
           active_run AS (
             SELECT run_id
             FROM effect_dataset_active
             WHERE scope = $3
           ),
           removable AS (
             SELECT ranked.run_id
             FROM ranked
             LEFT JOIN active_run ON active_run.run_id = ranked.run_id
             WHERE ranked.rn > $1 AND active_run.run_id IS NULL
           )
           DELETE FROM effect_dataset_run
           WHERE run_id IN (SELECT run_id FROM removable)
           RETURNING run_id`,
          [retentionKeepRuns, CANONICAL_DATASET_KIND, CANONICAL_RUNTIME_SCOPE]
        );
        retentionRemovedRunIds = retentionResult.rows.map((row) => row.run_id).sort();
      }

      for (const entity of recordsByEntity) {
        const seen = new Set<string>();
        for (const record of entity.records) {
          if (seen.has(record.naturalKey)) {
            duplicateNaturalKeys += 1;
            if (strict) {
              throw new Error(`duplicate natural key detected during load: ${entity.entityType}:${record.naturalKey}`);
            }
            continue;
          }
          seen.add(record.naturalKey);

          const upsertResult = await client.query<{ inserted: boolean }>(
            `INSERT INTO canonical_ingestion_records (
              entity_type, natural_key, payload, source_label, feed_id, run_id, content_hash
            ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
            ON CONFLICT (entity_type, natural_key) DO UPDATE SET
              payload = EXCLUDED.payload,
              source_label = EXCLUDED.source_label,
              feed_id = EXCLUDED.feed_id,
              run_id = EXCLUDED.run_id,
              content_hash = EXCLUDED.content_hash,
              last_seen_at = NOW()
            RETURNING (xmax = 0) AS inserted`,
            [
              entity.entityType,
              record.naturalKey,
              JSON.stringify(record.payload),
              validated.manifest.sourceLabel,
              validated.manifest.feedId,
              validated.manifest.runId,
              validated.manifest.contentHash,
            ]
          );

          if (upsertResult.rows[0]?.inserted) inserted += 1;
          else updated += 1;
        }
      }

      if (strict && orphanViolations.length > 0) {
        const sample = orphanViolations
          .slice(0, 5)
          .map((violation) => `${violation.entityType}:${violation.naturalKey}.${violation.field}->${violation.referencedEntityType}:${violation.referencedNaturalKey}`)
          .join(", ");
        throw new Error(`orphan violations detected: ${orphanViolations.length}${sample ? ` (sample: ${sample})` : ""}`);
      }

      await client.query(
        `UPDATE canonical_ingestion_runs
         SET status = 'success',
             inserted_count = $1,
             updated_count = $2,
             duplicate_count = $3,
             orphan_count = $4,
             completed_at = NOW()
         WHERE id = $5`,
        [inserted, updated, duplicateNaturalKeys, orphanViolations.length, runId]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (runId != null) {
        await pool.query(
          `UPDATE canonical_ingestion_runs
           SET status = 'failed',
               validation_errors = $1::jsonb,
               completed_at = NOW()
           WHERE id = $2`,
          [JSON.stringify([String(error)]), runId]
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }

    const completedAt = Date.now();
    const loadReceipt: JsonValue = {
      schemaVersion: "1.0.0",
      feedId: validated.manifest.feedId,
      runId: validated.manifest.runId,
      status: duplicateNaturalKeys > 0 && !strict ? "partial" : "success",
      feedPath: validated.feedPath,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      sourceLabel: validated.manifest.sourceLabel,
      sourceVersion: validated.manifest.sourceVersion,
      snapshotId: validated.manifest.snapshotId,
      contentHash: validated.manifest.contentHash,
      entityCounts: stableSortObject(validated.manifest.entityCounts),
      upsertSummary: {
        inserted,
        updated,
        total: inserted + updated,
      },
      integrity: {
        validationOk: true,
        duplicateNaturalKeys,
        orphanViolations: orphanViolations.length,
        orphanSamples: orphanViolations.slice(0, 10),
      },
      runtimeDataset: {
        runId: validated.manifest.runId,
        contentHash: validated.manifest.contentHash,
        datasetKind,
        status: activateRuntimeDataset ? "active" : "staged",
        retentionKeepRuns: retentionKeepRuns ?? null,
        retentionRemovedRunIds,
      },
    };

    await writeLoadReceipt(loadReceiptPath, loadReceipt);

    console.log(`✅ load completed for ${validated.feedPath}`);
    console.log(`inserted=${inserted} updated=${updated}`);
    console.log(`runtimeDataset=${validated.manifest.runId}:${activateRuntimeDataset ? "active" : "staged"}`);
    console.log(`loadReceipt=${loadReceiptPath}`);
  } finally {
    await pool.end();
  }
}

async function cmdDiff(args: string[]): Promise<void> {
  const a = parseFlag(args, "--a");
  const b = parseFlag(args, "--b");
  if (!a || !b) {
    throw new Error("diff requires --a <feedId-or-path> --b <feedId-or-path>");
  }
  const feedsRoot = parseFlag(args, "--feeds-root") ?? "data/feeds";

  const feedA = await validateFeed(a, feedsRoot);
  const feedB = await validateFeed(b, feedsRoot);
  const changedEntityTypes = new Set<string>();

  const allEntityTypes = new Set([
    ...Object.keys(feedA.manifest.entityHashes),
    ...Object.keys(feedB.manifest.entityHashes),
  ]);

  for (const entityType of [...allEntityTypes].sort()) {
    if (feedA.manifest.entityHashes[entityType] !== feedB.manifest.entityHashes[entityType]) {
      changedEntityTypes.add(entityType);
    }
  }

  console.log(`A: ${feedA.feedPath}`);
  console.log(`B: ${feedB.feedPath}`);

  if (changedEntityTypes.size === 0) {
    console.log("No entity hash changes");
    return;
  }

  console.log("Changed entities:");
  for (const entityType of [...changedEntityTypes]) {
    const aRecords = feedA.entityFiles[entityType]?.records ?? [];
    const bRecords = feedB.entityFiles[entityType]?.records ?? [];
    const details = compareRecordsByNaturalKey(entityType, aRecords, bRecords);
    const sample = [...details.changed, ...details.added, ...details.removed].slice(0, 5);
    console.log(
      `- ${entityType}: +${details.added.length} -${details.removed.length} ~${details.changed.length}`
      + (sample.length > 0 ? ` sample=[${sample.join(", ")}]` : "")
    );
  }
}

interface RuntimeStatusRow {
  runId: string;
  contentHash: string;
  datasetKind: string;
  sourceLabel: string;
  sourceVersion: string | null;
  snapshotId: string | null;
  status: string;
  createdAt: string;
  activatedAt: string | null;
}

async function cmdStatus(args: string[]): Promise<void> {
  const dbUrl = parseFlag(args, "--db-url") ?? process.env.DATABASE_URL ?? "postgres://majel:majel@localhost:5432/majel";
  const scope = parseFlag(args, "--scope") ?? CANONICAL_RUNTIME_SCOPE;
  const limit = parsePositiveIntFlag(args, "--limit") ?? 10;

  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    await ensureIngestionSchema(pool);

    const activeResult = await pool.query<{ scope: string; run_id: string; updated_at: string }>(
      `SELECT scope, run_id, updated_at
       FROM effect_dataset_active
       WHERE scope = $1`,
      [scope]
    );

    const runsResult = await pool.query<RuntimeStatusRow>(
      `SELECT
         run_id AS "runId",
         content_hash AS "contentHash",
         dataset_kind AS "datasetKind",
         source_label AS "sourceLabel",
         source_version AS "sourceVersion",
         snapshot_id AS "snapshotId",
         status,
         created_at AS "createdAt",
         activated_at AS "activatedAt"
       FROM effect_dataset_run
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    const active = activeResult.rows[0] ?? null;
    const payload = {
      scope,
      active: active
        ? {
            scope: active.scope,
            runId: active.run_id,
            updatedAt: active.updated_at,
          }
        : null,
      runs: runsResult.rows,
    };

    console.log(JSON.stringify(payload, null, 2));
  } finally {
    await pool.end();
  }
}

function usage(): string {
  return [
    "Usage:",
    "  tsx scripts/data-ingestion.ts validate --feed <feedId-or-path> [--feeds-root data/feeds]",
    "  tsx scripts/data-ingestion.ts load --feed <feedId-or-path> [--feeds-root data/feeds] [--db-url <postgres-url>] [--activate-runtime-dataset] [--retention-keep-runs <n>]",
    "  tsx scripts/data-ingestion.ts diff --a <feedId-or-path> --b <feedId-or-path> [--feeds-root data/feeds]",
    "  tsx scripts/data-ingestion.ts status [--db-url <postgres-url>] [--scope global] [--limit 10]",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "validate") {
    await cmdValidate(args.slice(1));
    return;
  }

  if (command === "load") {
    await cmdLoad(args.slice(1));
    return;
  }

  if (command === "diff") {
    await cmdDiff(args.slice(1));
    return;
  }

  if (command === "status") {
    await cmdStatus(args.slice(1));
    return;
  }

  console.log(usage());
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
