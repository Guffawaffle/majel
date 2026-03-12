/**
 * ingestion-entity.ts — Entity key extraction, orphan detection, record comparison
 */

import type { JsonValue, PreparedEntityRecords, OrphanViolation } from "./ingestion-types.js";
import { toObject, sha256Hex, stableJsonStringify } from "./ingestion-types.js";

export function extractNaturalKey(entityType: string, record: JsonValue): string | undefined {
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

export function findOrphanViolations(entities: PreparedEntityRecords[]): OrphanViolation[] {
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

export function compareRecordsByNaturalKey(entityType: string, a: JsonValue[], b: JsonValue[]): {
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
