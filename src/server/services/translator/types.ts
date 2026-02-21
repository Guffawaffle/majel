/**
 * translator/types.ts — External Overlay Translator types (#78)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * TypeScript interfaces for config-driven translation of external game data
 * into MajelGameExport format. Adding a new external source requires only
 * a new .translator.json file — no code changes.
 *
 * Matches: schemas/translator-config.schema.json
 */

// ─── Transform Types ────────────────────────────────────────

/** Allowed transform operations applied to individual field values. */
export type TransformType = "lookup" | "toString" | "toNumber" | "toBoolean";

/** A transform rule applied to a single field value during translation. */
export interface FieldTransform {
  /** Transform type. 'lookup' maps via a table; others coerce the value. */
  type: TransformType;
  /** Lookup table for 'lookup' transforms. Keys are source values (as strings). */
  table?: Record<string, unknown>;
}

// ─── Entity Mappings ────────────────────────────────────────

/** Per-entity-type mapping config (officers or ships). */
export interface EntityMapping {
  /** Dot-notation JSON path to the source array (e.g. "data.officers"). */
  sourcePath: string;
  /** Field in the source object that holds the entity ID (e.g. "officer_id"). */
  idField: string;
  /** Majel refId prefix prepended to the source ID (e.g. "cdn:officer:"). */
  idPrefix: string;
  /** Maps source field names → MajelGameExport field names. */
  fieldMap: Record<string, string>;
  /** Default values for fields not present in source data. */
  defaults?: Record<string, unknown>;
  /** Per-field transform rules keyed by target field name. */
  transforms?: Record<string, FieldTransform>;
}

/** Specialized dock mapping — docks use number + shipId, not a refId. */
export interface DockMapping {
  /** Dot-notation JSON path to the source array (e.g. "data.docks"). */
  sourcePath: string;
  /** Maps source field names → MajelGameExport dock field names. */
  fieldMap: Record<string, string>;
  /** Optional prefix for shipId values (e.g. "cdn:ship:"). */
  shipIdPrefix?: string | null;
  /** Default values for fields not present in source data. */
  defaults?: Record<string, unknown>;
  /** Per-field transform rules keyed by target field name. */
  transforms?: Record<string, FieldTransform>;
}

// ─── Top-Level Config ───────────────────────────────────────

/** Top-level translator configuration — one per external source. */
export interface TranslatorConfig {
  /** Human-readable name (e.g. "STFC Command Center"). */
  name: string;
  /** Config version string (e.g. "1.0"). */
  version: string;
  /** Optional description of the external source. */
  description?: string | null;
  /** Source identifier for MajelGameExport.source and receipt tracking. */
  sourceType: string;
  /** Officer entity mapping. */
  officers?: EntityMapping;
  /** Ship entity mapping. */
  ships?: EntityMapping;
  /** Dock assignment mapping. */
  docks?: DockMapping;
}

// ─── Translation Output ─────────────────────────────────────

/** Counts of translated, skipped, and errored items per entity category. */
export interface TranslationStats {
  officers: { translated: number; skipped: number; errored: number };
  ships: { translated: number; skipped: number; errored: number };
  docks: { translated: number; skipped: number; errored: number };
}

/** Result of a translation run — translated payload + diagnostics. */
export interface TranslationResult {
  /** Whether the translation completed without fatal errors. */
  success: boolean;
  /** The translated MajelGameExport payload (null on fatal error). */
  data: {
    version: string;
    exportDate?: string;
    source?: string;
    officers?: Array<{
      refId: string;
      level?: number | null;
      rank?: string | null;
      power?: number | null;
      owned?: boolean;
      tier?: number | null;
    }>;
    ships?: Array<{
      refId: string;
      tier?: number | null;
      level?: number | null;
      power?: number | null;
      owned?: boolean;
    }>;
    docks?: Array<{
      number?: number;
      shipId?: string;
      loadoutId?: number;
    }>;
  } | null;
  /** Per-category translation statistics. */
  stats: TranslationStats;
  /** Non-fatal warnings encountered during translation. */
  warnings: string[];
}
