/**
 * translator/translate.ts — Core Translation Engine (#78, Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Config-driven translation of external game data into MajelGameExport
 * format. Each external source is described by a `.translator.json` config
 * file; no code changes are required to add new sources.
 *
 * The translator performs faithful field mapping, defaults, and type
 * coercion. It does NOT apply MajelGameExport validation rules — that
 * happens downstream when sync_overlay receives the translated data.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { rootLogger } from "../../logger.js";
import type {
  TranslatorConfig,
  EntityMapping,
  DockMapping,
  FieldTransform,
  TranslationResult,
  TranslationStats,
} from "./types.js";

const log = rootLogger.child({ subsystem: "translator" });

// ─── Path Traversal ─────────────────────────────────────────

/**
 * Resolve a dot-notation path against a payload object.
 *
 * @param payload - The root object to traverse.
 * @param path - Dot-delimited path (e.g. "data.officers").
 * @returns The value at the path, or `undefined` if any segment is missing.
 */
export function resolveSourcePath(payload: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = payload;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ─── Transforms ─────────────────────────────────────────────

/**
 * Apply a single transform to a field value.
 *
 * - `lookup`: maps `String(value)` through `transform.table`; returns the
 *   original value if the key is not found.
 * - `toString`: coerces to string via `String()`.
 * - `toNumber`: coerces via `Number()`; returns `null` if the result is NaN.
 * - `toBoolean`: truthy coercion with special string handling —
 *   `"true"/"1"/"yes"` → `true`, `"false"/"0"/"no"/""` → `false`.
 *
 * @param value - The raw field value.
 * @param transform - The transform descriptor.
 * @returns The transformed value.
 */
export function applyTransform(value: unknown, transform: FieldTransform): unknown {
  switch (transform.type) {
    case "lookup": {
      const key = String(value);
      if (transform.table && key in transform.table) {
        return transform.table[key];
      }
      return value;
    }
    case "toString":
      return String(value);
    case "toNumber": {
      const num = Number(value);
      return Number.isNaN(num) ? null : num;
    }
    case "toBoolean": {
      if (typeof value === "string") {
        const lower = value.toLowerCase().trim();
        if (lower === "true" || lower === "1" || lower === "yes") return true;
        if (lower === "false" || lower === "0" || lower === "no" || lower === "") return false;
      }
      return Boolean(value);
    }
    default:
      return value;
  }
}

// ─── Config Loading ─────────────────────────────────────────

/**
 * Load and validate a translator config from a `.translator.json` file.
 *
 * @param configPath - Absolute or relative path to the config file.
 * @returns The parsed `TranslatorConfig`.
 * @throws If the file cannot be read or required fields are missing.
 */
export async function loadTranslatorConfig(configPath: string): Promise<TranslatorConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read translator config at ${configPath}: ${(err as Error).message}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in translator config at ${configPath}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Translator config at ${configPath} must be a JSON object`);
  }

  const config = parsed as Record<string, unknown>;

  if (typeof config.name !== "string" || !config.name) {
    throw new Error(`Translator config at ${configPath} is missing required field 'name'`);
  }
  if (typeof config.version !== "string" || !config.version) {
    throw new Error(`Translator config at ${configPath} is missing required field 'version'`);
  }
  if (typeof config.sourceType !== "string" || !config.sourceType) {
    throw new Error(`Translator config at ${configPath} is missing required field 'sourceType'`);
  }

  log.debug({ path: configPath, name: config.name }, "loaded translator config");
  return config as unknown as TranslatorConfig;
}

/**
 * List available translator configs in a directory.
 *
 * Scans for `*.translator.json` files and returns lightweight metadata
 * without fully loading each config.
 *
 * @param configDir - Directory to scan.
 * @returns Array of config summaries with path, name, sourceType, and description.
 */
export async function listTranslatorConfigs(
  configDir: string,
): Promise<Array<{ name: string; sourceType: string; description?: string | null; path: string }>> {
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch {
    log.warn({ configDir }, "translator config directory not found");
    return [];
  }

  const configFiles = entries.filter((f) => f.endsWith(".translator.json"));
  const results: Array<{ name: string; sourceType: string; description?: string | null; path: string }> = [];

  for (const file of configFiles) {
    const filePath = join(configDir, file);
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.name === "string" && typeof parsed.sourceType === "string") {
        results.push({
          name: parsed.name as string,
          sourceType: parsed.sourceType as string,
          description: typeof parsed.description === "string" ? parsed.description : (parsed.description as string | null | undefined) ?? null,
          path: filePath,
        });
      }
    } catch {
      log.warn({ file: filePath }, "skipping unreadable translator config");
    }
  }

  return results;
}

// ─── Internal Helpers ───────────────────────────────────────

/** Create a fresh zero-count stats object. */
function emptyStats(): TranslationStats {
  return {
    officers: { translated: 0, skipped: 0, errored: 0 },
    ships: { translated: 0, skipped: 0, errored: 0 },
    docks: { translated: 0, skipped: 0, errored: 0 },
  };
}

/**
 * Map fields from a source item to a target item using a fieldMap,
 * then layer in defaults and apply transforms.
 */
function mapFields(
  sourceItem: Record<string, unknown>,
  fieldMap: Record<string, string>,
  defaults?: Record<string, unknown>,
  transforms?: Record<string, FieldTransform>,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};

  // 1. Map source fields → target fields
  for (const [sourceKey, targetKey] of Object.entries(fieldMap)) {
    if (sourceKey in sourceItem) {
      target[targetKey] = sourceItem[sourceKey];
    }
  }

  // 2. Apply defaults for missing target fields
  if (defaults) {
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in target) || target[key] === undefined || target[key] === null) {
        target[key] = value;
      }
    }
  }

  // 3. Apply transforms (keyed by target field name)
  if (transforms) {
    for (const [targetKey, transform] of Object.entries(transforms)) {
      if (targetKey in target) {
        target[targetKey] = applyTransform(target[targetKey], transform);
      }
    }
  }

  return target;
}

/**
 * Translate an entity array (officers or ships) using an EntityMapping.
 */
function translateEntities(
  sourceArray: unknown[],
  mapping: EntityMapping,
  category: "officers" | "ships",
  stats: TranslationStats,
  warnings: string[],
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];

  for (let i = 0; i < sourceArray.length; i++) {
    const item = sourceArray[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      stats[category].errored++;
      warnings.push(`${category}[${i}]: skipped — not a valid object`);
      continue;
    }

    const sourceItem = item as Record<string, unknown>;
    const rawId = sourceItem[mapping.idField];

    if (rawId === undefined || rawId === null || rawId === "") {
      stats[category].errored++;
      warnings.push(`${category}[${i}]: skipped — missing idField '${mapping.idField}'`);
      continue;
    }

    const refId = `${mapping.idPrefix}${String(rawId)}`;
    const mapped = mapFields(sourceItem, mapping.fieldMap, mapping.defaults, mapping.transforms);
    mapped.refId = refId;

    output.push(mapped);
    stats[category].translated++;
  }

  return output;
}

/**
 * Translate a dock array using a DockMapping.
 */
function translateDocks(
  sourceArray: unknown[],
  mapping: DockMapping,
  stats: TranslationStats,
  warnings: string[],
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];

  for (let i = 0; i < sourceArray.length; i++) {
    const item = sourceArray[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      stats.docks.errored++;
      warnings.push(`docks[${i}]: skipped — not a valid object`);
      continue;
    }

    const sourceItem = item as Record<string, unknown>;
    const mapped = mapFields(sourceItem, mapping.fieldMap, mapping.defaults, mapping.transforms);

    // Apply shipIdPrefix if provided
    if (mapping.shipIdPrefix && typeof mapped.shipId === "string" && mapped.shipId) {
      mapped.shipId = `${mapping.shipIdPrefix}${mapped.shipId}`;
    }

    output.push(mapped);
    stats.docks.translated++;
  }

  return output;
}

// ─── Core Translation ───────────────────────────────────────

/**
 * Translate an external game data payload into MajelGameExport format
 * using the provided translator config.
 *
 * The translator faithfully maps fields, applies defaults and transforms,
 * but does NOT validate the output against MajelGameExport rules —
 * downstream consumers (sync_overlay) handle that.
 *
 * @param config - The translator configuration.
 * @param externalPayload - Raw external data (parsed JSON).
 * @returns A `TranslationResult` with translated data, stats, and warnings.
 */
export function translate(config: TranslatorConfig, externalPayload: unknown): TranslationResult {
  const stats = emptyStats();
  const warnings: string[] = [];

  // Validate payload is a non-null object
  if (externalPayload === null || externalPayload === undefined || typeof externalPayload !== "object" || Array.isArray(externalPayload)) {
    log.warn({ sourceType: config.sourceType }, "translate: payload is not a valid object");
    return {
      success: false,
      data: null,
      stats,
      warnings: ["payload must be a non-null object"],
    };
  }

  const data: NonNullable<TranslationResult["data"]> = {
    version: "1.0",
    exportDate: new Date().toISOString(),
    source: config.sourceType,
  };

  // ── Officers ──────────────────────────────────────────────
  if (config.officers) {
    const resolved = resolveSourcePath(externalPayload, config.officers.sourcePath);
    if (!Array.isArray(resolved)) {
      warnings.push(`officers: sourcePath '${config.officers.sourcePath}' did not resolve to an array`);
    } else {
      data.officers = translateEntities(resolved, config.officers, "officers", stats, warnings) as NonNullable<TranslationResult["data"]>["officers"];
    }
  }

  // ── Ships ─────────────────────────────────────────────────
  if (config.ships) {
    const resolved = resolveSourcePath(externalPayload, config.ships.sourcePath);
    if (!Array.isArray(resolved)) {
      warnings.push(`ships: sourcePath '${config.ships.sourcePath}' did not resolve to an array`);
    } else {
      data.ships = translateEntities(resolved, config.ships, "ships", stats, warnings) as NonNullable<TranslationResult["data"]>["ships"];
    }
  }

  // ── Docks ─────────────────────────────────────────────────
  if (config.docks) {
    const resolved = resolveSourcePath(externalPayload, config.docks.sourcePath);
    if (!Array.isArray(resolved)) {
      warnings.push(`docks: sourcePath '${config.docks.sourcePath}' did not resolve to an array`);
    } else {
      data.docks = translateDocks(resolved, config.docks, stats, warnings) as NonNullable<TranslationResult["data"]>["docks"];
    }
  }

  // Success if at least one entity was translated
  const totalTranslated = stats.officers.translated + stats.ships.translated + stats.docks.translated;
  const success = totalTranslated > 0;

  if (!success) {
    warnings.push("no entities were successfully translated");
  }

  log.info(
    {
      sourceType: config.sourceType,
      success,
      officers: stats.officers.translated,
      ships: stats.ships.translated,
      docks: stats.docks.translated,
      warnings: warnings.length,
    },
    "translation complete",
  );

  return { success, data, stats, warnings };
}
