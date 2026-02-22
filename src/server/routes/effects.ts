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

export function createEffectsRoutes(appState: AppState): Router {
  const router = createSafeRouter();

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

  /**
   * GET /api/effects/bundle
   *
   * Fetch the complete effect bundle (intents + abilities + effects).
   * Cacheable by clients (ETag, Cache-Control).
   */
  router.get("/api/effects/bundle", async (_req, res) => {
    if (!requireEffectStore(res) || !requireReferenceStore(res)) return;

    try {
      const effectStore = appState.effectStore!;
      const referenceStore = appState.referenceStore!;

      // 1. Fetch all intents with weights
      const intentRows = await effectStore.listIntents();
      const intents = await Promise.all(
        intentRows.map(async (row) => {
          const intent = await effectStore.getIntent(row.id);
          if (!intent) return null;

          // Parse default context
          const ctx = intent.defaultContext;
          const defaultContext = ctx
            ? {
              targetKind: ctx.targetKind,
              engagement: ctx.engagement,
              targetTags: ctx.targetTagsJson ? JSON.parse(ctx.targetTagsJson) : [],
            }
            : null;

          return {
            id: row.id,
            name: row.name,
            description: row.description,
            defaultContext,
            effectWeights: intent.effectWeights.reduce(
              (acc, ew) => {
                acc[ew.effectKey] = ew.weight;
                return acc;
              },
              {} as Record<string, number>,
            ),
          };
        }),
      );

      // 2. Fetch all officers from reference store
      const allOfficers = await referenceStore.listOfficers();
      const officerIds = allOfficers.map((o) => o.id);

      // 3. Fetch abilities for all officers
      const abilitiesByOfficer = await effectStore.getOfficerAbilitiesBulk(officerIds);

      // 4. Assemble response
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

      const bundle: EffectBundleResponse = {
        schemaVersion: "1.0.0",
        intents: intents.filter(Boolean) as EffectBundleResponse["intents"],
        officers,
      };

      sendOk(res, bundle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INTERNAL_ERROR, `Failed to fetch effect bundle: ${message}`, 500);
    }
  });

  return router;
}
