/**
 * routes/effects.ts — Effect Taxonomy API (ADR-034 #132)
 *
 * Endpoint for fetching the effect catalog bundle:
 * - Intent definitions + effect weight vectors
 * - Officer abilities + effects + conditions + applicability
 *
 * Used by the web app for effect-based crew recommendations.
 * No authentication required — data is public/reference.
 */

import type { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { createSafeRouter } from "../safe-router.js";
import { getCanonicalObjectiveArtifact } from "../services/canonical-objectives.js";
import { sha256Hex, stableJsonStringify } from "../services/effects-contract-v3.js";

export interface EffectBundleResponse {
  schemaVersion: string;
  intents: {
    id: string;
    name: string;
    description: string;
    defaultContext: {
      targetKind: string;
      engagement: string;
      targetTags: string[];
    } | null;
    effectWeights: Record<string, number>;
  }[];
  officers: Record<
    string,
    {
      id: string;
      name: string;
      abilities: {
        id: string;
        slot: string;
        name: string | null;
        rawText: string | null;
        isInert: boolean;
        effects: {
          id: string;
          effectKey: string;
          magnitude: number | null;
          unit: string | null;
          stacking: string | null;
          applicableTargetKinds: string[];
          applicableTargetTags: string[];
          conditions: {
            conditionKey: string;
            params: Record<string, string> | null;
          }[];
        }[];
      }[];
    }
  >;
}

interface RuntimeManifestResponse {
  schemaVersion: "1.0.0";
  generatedAt: string;
  bundleHash: string;
  paths: {
    taxonomy: string;
    officersIndex: string;
    chunks: string[];
  };
}

interface RuntimeArtifacts {
  bundleHash: string;
  manifest: RuntimeManifestResponse;
  manifestHash: string;
  taxonomy: {
    schemaVersion: string;
    intents: EffectBundleResponse["intents"];
  };
  taxonomyHash: string;
  officersIndex: {
    schemaVersion: string;
    officers: Array<{
      officerId: string;
      officerName: string;
      abilityCount: number;
      chunkPath: string;
    }>;
    chunkPaths: string[];
  };
  officersIndexHash: string;
  chunks: Array<{
    path: string;
    hash: string;
    payload: {
      schemaVersion: string;
      officers: Record<string, EffectBundleResponse["officers"][string]>;
    };
  }>;
}

export function createEffectsRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const RUNTIME_ARTIFACT_TTL_MS = 60_000;
  let runtimeArtifactsCache: {
    expiresAt: number;
    artifacts: RuntimeArtifacts;
    bundleHash: string;
  } | null = null;

  router.get("/api/effects/objectives", async (_req, res) => {
    try {
      const artifact = await getCanonicalObjectiveArtifact();
      sendOk(res, {
        schemaVersion: "1.0.0",
        objectives: artifact.intents,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Canonical objectives assembly failed:", message);
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to fetch canonical objectives", 500);
    }
  });

  // ── Helpers ─────────────────────────────────────────────

  function requireEffectStore(res: import("express").Response): boolean {
    if (!appState.effectStore) {
      sendFail(res, ErrorCode.EFFECT_STORE_NOT_AVAILABLE, "Effect store not available", 503);
      return false;
    }
    return true;
  }

  function requireReferenceStore(res: import("express").Response): boolean {
    if (!appState.referenceStore) {
      sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
      return false;
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────

  async function assembleEffectBundle(): Promise<EffectBundleResponse> {
    const effectStore = appState.effectStore!;
    const referenceStore = appState.referenceStore!;

    const intentsFull = await effectStore.listIntentsFull();
    const intents = intentsFull.map((intent) => {
      const ctx = intent.defaultContext;
      const defaultContext = ctx
        ? {
          targetKind: ctx.targetKind,
          engagement: ctx.engagement,
          targetTags: ctx.targetTagsJson ? JSON.parse(ctx.targetTagsJson) : [],
        }
        : null;

      return {
        id: intent.id,
        name: intent.name,
        description: intent.description,
        defaultContext,
        effectWeights: intent.effectWeights.reduce(
          (acc, ew) => {
            acc[ew.effectKey] = ew.weight;
            return acc;
          },
          {} as Record<string, number>,
        ),
      };
    });

    const allOfficers = (await referenceStore.listOfficers()).sort((left, right) => left.id.localeCompare(right.id));
    const officerIds = allOfficers.map((officer) => officer.id);
    const abilitiesByOfficer = await effectStore.getOfficerAbilitiesBulk(officerIds);

    const officers: Record<string, EffectBundleResponse["officers"][string]> = {};
    for (const officer of allOfficers) {
      const abilities = abilitiesByOfficer.get(officer.id) ?? [];
      officers[officer.id] = {
        id: officer.id,
        name: officer.name,
        abilities: abilities.map((ab) => ({
          id: ab.id,
          slot: ab.slot,
          name: ab.name,
          rawText: ab.rawText,
          isInert: ab.isInert,
          effects: ab.effects.map((ef) => ({
            id: ef.id,
            effectKey: ef.effectKey,
            magnitude: ef.magnitude,
            unit: ef.unit,
            stacking: ef.stacking,
            applicableTargetKinds: ef.targetKinds,
            applicableTargetTags: ef.targetTags,
            conditions: ef.conditions.map((cond) => ({
              conditionKey: cond.conditionKey,
              params: cond.params,
            })),
          })),
        })),
      };
    }

    return {
      schemaVersion: "1.0.0",
      intents,
      officers,
    };
  }

  function buildRuntimeArtifacts(
    bundle: EffectBundleResponse,
    bundleHash: string,
    bundleBuiltAt: string,
  ): RuntimeArtifacts {
    const taxonomyPayload = {
      schemaVersion: bundle.schemaVersion,
      intents: bundle.intents,
    };
    const taxonomyHash = sha256Hex(stableJsonStringify(taxonomyPayload)).slice(0, 16);
    const taxonomyPath = `/api/effects/runtime/taxonomy.${taxonomyHash}.json`;

    const officerEntries = Object.entries(bundle.officers).sort(([left], [right]) => left.localeCompare(right));
    const chunkSize = 64;
    const chunks: RuntimeArtifacts["chunks"] = [];

    for (let chunkIndex = 0; chunkIndex * chunkSize < officerEntries.length; chunkIndex += 1) {
      const start = chunkIndex * chunkSize;
      const end = start + chunkSize;
      const chunkOfficers = Object.fromEntries(officerEntries.slice(start, end));
      const payload = {
        schemaVersion: bundle.schemaVersion,
        officers: chunkOfficers,
      };
      const hash = sha256Hex(stableJsonStringify(payload)).slice(0, 16);
      const chunkId = String(chunkIndex + 1).padStart(4, "0");
      const path = `/api/effects/runtime/chunk-${chunkId}.${hash}.json`;
      chunks.push({ path, hash, payload });
    }

    const chunkByOfficerId = new Map<string, string>();
    for (const chunk of chunks) {
      for (const officerId of Object.keys(chunk.payload.officers)) {
        chunkByOfficerId.set(officerId, chunk.path);
      }
    }

    const officersIndexPayload = {
      schemaVersion: bundle.schemaVersion,
      officers: officerEntries.map(([officerId, officer]) => ({
        officerId,
        officerName: officer.name,
        abilityCount: officer.abilities.length,
        chunkPath: chunkByOfficerId.get(officerId) ?? "",
      })),
      chunkPaths: chunks.map((chunk) => chunk.path),
    };

    const officersIndexHash = sha256Hex(stableJsonStringify(officersIndexPayload)).slice(0, 16);
    const officersIndexPath = `/api/effects/runtime/officers.index.${officersIndexHash}.json`;

    const manifest: RuntimeManifestResponse = {
      schemaVersion: "1.0.0",
      generatedAt: bundleBuiltAt,
      bundleHash,
      paths: {
        taxonomy: taxonomyPath,
        officersIndex: officersIndexPath,
        chunks: chunks.map((chunk) => chunk.path),
      },
    };

    const manifestHash = bundleHash;

    return {
      bundleHash,
      manifest,
      manifestHash,
      taxonomy: taxonomyPayload,
      taxonomyHash,
      officersIndex: officersIndexPayload,
      officersIndexHash,
      chunks,
    };
  }

  function maybeSendNotModified(req: import("express").Request, res: import("express").Response, etag: string): boolean {
    res.setHeader("ETag", etag);
    const headerValue = req.headers["if-none-match"];
    const candidates = typeof headerValue === "string"
      ? headerValue.split(",").map((part) => part.trim())
      : [];

    if (candidates.includes(etag) || candidates.includes("*")) {
      res.status(304).end();
      return true;
    }
    return false;
  }

  async function getRuntimeArtifacts(): Promise<RuntimeArtifacts> {
    const now = Date.now();
    if (runtimeArtifactsCache && runtimeArtifactsCache.expiresAt > now) {
      return runtimeArtifactsCache.artifacts;
    }

    const bundle = await assembleEffectBundle();
    const bundleHash = sha256Hex(stableJsonStringify(bundle)).slice(0, 16);

    if (runtimeArtifactsCache && runtimeArtifactsCache.bundleHash === bundleHash) {
      runtimeArtifactsCache = {
        ...runtimeArtifactsCache,
        expiresAt: now + RUNTIME_ARTIFACT_TTL_MS,
      };
      return runtimeArtifactsCache.artifacts;
    }

    const bundleBuiltAt = new Date().toISOString();
    const artifacts = buildRuntimeArtifacts(bundle, bundleHash, bundleBuiltAt);
    runtimeArtifactsCache = {
      artifacts,
      expiresAt: now + RUNTIME_ARTIFACT_TTL_MS,
      bundleHash,
    };
    return artifacts;
  }

  /**
   * GET /api/effects/bundle
   *
   * Fetch the complete effect bundle (intents + abilities + effects).
   * Cacheable by clients (ETag, Cache-Control).
   */
  router.get("/api/effects/bundle", async (_req, res) => {
    if (!requireEffectStore(res) || !requireReferenceStore(res)) return;

    try {
      const bundle = await assembleEffectBundle();
      sendOk(res, bundle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Effect bundle assembly failed:", message);
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to fetch effect bundle", 500);
    }
  });

  router.get("/api/effects/runtime/manifest.json", async (req, res) => {
    if (!requireEffectStore(res) || !requireReferenceStore(res)) return;

    try {
      const runtime = await getRuntimeArtifacts();
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      const etag = `"effects-manifest-${runtime.manifest.bundleHash}"`;
      if (maybeSendNotModified(req, res, etag)) return;
      res.status(200).json(runtime.manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Effects runtime manifest failed:", message);
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to fetch effects runtime manifest", 500);
    }
  });

  router.get("/api/effects/runtime/health", async (_req, res) => {
    if (!requireEffectStore(res) || !requireReferenceStore(res)) return;

    try {
      const effectStore = appState.effectStore!;
      const referenceStore = appState.referenceStore!;
      const activeRun = await effectStore.getActiveDatasetRun();
      const generatedAt = new Date().toISOString();

      const inferRunIdFromAbilityId = (abilityId: string | null | undefined): string | null => {
        if (!abilityId) return null;
        const cdnDelimiter = abilityId.indexOf(":cdn:");
        if (cdnDelimiter > 0) return abilityId.slice(0, cdnDelimiter);
        const firstColon = abilityId.indexOf(":");
        if (firstColon > 0) return abilityId.slice(0, firstColon);
        return null;
      };

      const officers = (await referenceStore.listOfficers())
        .sort((left, right) => left.id.localeCompare(right.id));
      const sampledKeys = officers.slice(0, 5).map((officer) => officer.id);
      const lookupMap = await effectStore.getOfficerAbilitiesBulk(sampledKeys);
      const missingLookup = await effectStore.getOfficerAbilitiesBulk(["__missing_officer_id__"]);

      const lookupByKey = sampledKeys.map((officerId) => {
        const abilities = lookupMap.get(officerId) ?? [];
        return {
          naturalKey: officerId,
          runId: inferRunIdFromAbilityId(abilities[0]?.id ?? null) ?? activeRun?.runId ?? null,
          abilityCount: abilities.length,
        };
      });

      const status = lookupByKey.every((entry) => entry.abilityCount > 0) ? "ok" : "degraded";

      res.status(200).json({
        schemaVersion: "1.0.0",
        generatedAt,
        status,
        activeRun: activeRun
          ? {
              runId: activeRun.runId,
              datasetKind: activeRun.datasetKind,
              contentHash: activeRun.contentHash,
              activatedAt: activeRun.activatedAt,
            }
          : null,
        sample: {
          requested: sampledKeys.length,
          sampledKeys,
          lookupByKey,
        },
        fallback: {
          zeroResultStable: !missingLookup.has("__missing_officer_id__") || (missingLookup.get("__missing_officer_id__") ?? []).length === 0,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Effects runtime health failed:", message);
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to fetch effects runtime health", 500);
    }
  });

  router.get("/api/effects/runtime/taxonomy.:hash.json", async (req, res) => {
    if (!requireEffectStore(res) || !requireReferenceStore(res)) return;

    try {
      const runtime = await getRuntimeArtifacts();
      const requestedHash = req.params.hash;
      if (requestedHash !== runtime.taxonomyHash) {
        sendFail(res, ErrorCode.NOT_FOUND, "taxonomy artifact hash not found", 404);
        return;
      }

      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      const etag = `"effects-taxonomy-${runtime.taxonomyHash}"`;
      if (maybeSendNotModified(req, res, etag)) return;
      res.status(200).json(runtime.taxonomy);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Effects runtime taxonomy failed:", message);
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to fetch effects runtime taxonomy", 500);
    }
  });

  router.get("/api/effects/runtime/officers.index.:hash.json", async (req, res) => {
    if (!requireEffectStore(res) || !requireReferenceStore(res)) return;

    try {
      const runtime = await getRuntimeArtifacts();
      const requestedHash = req.params.hash;
      if (requestedHash !== runtime.officersIndexHash) {
        sendFail(res, ErrorCode.NOT_FOUND, "officers index artifact hash not found", 404);
        return;
      }

      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      const etag = `"effects-index-${runtime.officersIndexHash}"`;
      if (maybeSendNotModified(req, res, etag)) return;
      res.status(200).json(runtime.officersIndex);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Effects runtime officers index failed:", message);
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to fetch effects runtime officers index", 500);
    }
  });

  router.get("/api/effects/runtime/chunk-:chunkId.:hash.json", async (req, res) => {
    if (!requireEffectStore(res) || !requireReferenceStore(res)) return;

    try {
      const runtime = await getRuntimeArtifacts();
      const requestedHash = req.params.hash;
      const requestedChunk = req.params.chunkId;
      const chunk = runtime.chunks.find((entry) => {
        const id = entry.path.match(/chunk-(\d{4})\./)?.[1];
        return id === requestedChunk && entry.hash === requestedHash;
      });

      if (!chunk) {
        sendFail(res, ErrorCode.NOT_FOUND, "chunk artifact hash not found", 404);
        return;
      }

      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      const etag = `"effects-chunk-${requestedChunk}-${requestedHash}"`;
      if (maybeSendNotModified(req, res, etag)) return;
      res.status(200).json(chunk.payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Effects runtime chunk failed:", message);
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to fetch effects runtime chunk", 500);
    }
  });

  return router;
}
