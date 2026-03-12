/**
 * ingestion-types.ts — Shared types and JSON/hash utilities for data ingestion
 */

import { createHash } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const CANONICAL_RUNTIME_SCOPE = "canonical-global";
export const CANONICAL_DATASET_KIND = "canonical";

export interface FeedManifest {
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

export interface EntityFile {
  schemaVersion: string;
  entityType: string;
  generatedAt: string;
  count: number;
  hash: string;
  records: JsonValue[];
}

export interface ValidatedFeed {
  feedPath: string;
  manifest: FeedManifest;
  entityFiles: Record<string, EntityFile>;
  errors: string[];
}

export interface PreparedEntityRecords {
  entityType: string;
  records: Array<{
    naturalKey: string;
    payload: JsonValue;
  }>;
}

export interface OrphanViolation {
  entityType: string;
  naturalKey: string;
  field: string;
  referencedEntityType: string;
  referencedNaturalKey: string;
}

// ─── JSON / Hash Utilities ──────────────────────────────────

export function toObject(value: JsonValue): JsonObject | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return undefined;
}

export function canonicalize(value: JsonValue): JsonValue {
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

export function stableJsonStringify(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function stableSortObject<T>(input: Record<string, T>): Record<string, T> {
  const output: Record<string, T> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = input[key];
  }
  return output;
}

export function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

// ─── CLI Flag Utilities ─────────────────────────────────────

export function parseFlag(args: string[], flag: string): string | undefined {
  const index = args.findIndex((value) => value === flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function parsePositiveIntFlag(args: string[], flag: string): number | undefined {
  const raw = parseFlag(args, flag);
  if (raw == null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} must be an integer >= 1`);
  }
  return parsed;
}
