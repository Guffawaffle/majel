/**
 * ingestion-feed.ts — Feed path resolution and validation
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FeedManifest, EntityFile, ValidatedFeed, JsonValue } from "./ingestion-types.js";
import { sha256Hex, stableJsonStringify, stableSortObject, hasOwn, toObject } from "./ingestion-types.js";
import { extractNaturalKey } from "./ingestion-entity.js";

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

export async function resolveFeedPath(feedsRoot: string, feedOrPath: string): Promise<string> {
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

export async function validateFeed(feedPathInput: string, feedsRoot: string): Promise<ValidatedFeed> {
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
