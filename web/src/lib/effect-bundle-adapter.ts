/**
 * effect-bundle-adapter.ts — Convert server bundle into web-usable structures
 *
 * Takes the EffectBundleResponse from /api/effects/bundle and converts it into
 * Maps and interfaces that the effect evaluator + recommender can use.
 */

import type {
  IntentDefinition,
  MagnitudeUnit,
  OfficerAbility,
  StackingMode,
  TargetContext,
} from "./types/effect-types.js";

/**
 * Bundle response from /api/effects/bundle (matches server type EffectBundleResponse)
 */
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

/**
 * Parsed bundle with intent weights and officer abilities indexed for easy lookup.
 */
export interface EffectBundleData {
  schemaVersion: string;
  intentWeights: Map<string, Record<string, number>>;
  officerAbilities: Map<string, OfficerAbility[]>;
  intents: Map<string, IntentDefinition>;
}

/**
 * Fetch and parse the effect bundle from the server.
 */
export async function fetchEffectBundle(): Promise<EffectBundleResponse> {
  const response = await fetch("/api/effects/bundle", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch effect bundle: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Adapt a raw EffectBundleResponse into indexed Maps for the recommender.
 */
export function adaptEffectBundle(raw: EffectBundleResponse): EffectBundleData {
  const intentWeights = new Map<string, Record<string, number>>();
  const officerAbilities = new Map<string, OfficerAbility[]>();
  const intents = new Map<string, IntentDefinition>();

  // Index intents and their weights
  for (const intent of raw.intents) {
    intentWeights.set(intent.id, intent.effectWeights);
    intents.set(intent.id, {
      id: intent.id,
      name: intent.name,
      description: intent.description,
      defaultContext: (intent.defaultContext ?? {
        targetKind: "hostile",
        engagement: "any",
        targetTags: [],
      }) as TargetContext,
      effectWeights: intent.effectWeights,
    });
  }

  // Index officer abilities and effects
  for (const [officerId, officerData] of Object.entries(raw.officers)) {
    const abilities: OfficerAbility[] = officerData.abilities.map((ab) => ({
      id: ab.id,
      officerId,
      slot: ab.slot as "cm" | "oa" | "bda",
      name: ab.name,
      rawText: ab.rawText,
      isInert: ab.isInert,
      effects: ab.effects.map((ef) => ({
        id: ef.id,
        abilityId: ab.id,
        effectKey: ef.effectKey,
        magnitude: ef.magnitude,
        unit: (ef.unit ?? null) as MagnitudeUnit | null,
        stacking: (ef.stacking ?? null) as StackingMode | null,
        applicableTargetKinds: ef.applicableTargetKinds,
        applicableTargetTags: ef.applicableTargetTags,
        conditions: ef.conditions.map((cond) => ({
          conditionKey: cond.conditionKey,
          params: cond.params,
        })),
      })),
    }));
    officerAbilities.set(officerId, abilities);
  }

  return {
    schemaVersion: raw.schemaVersion,
    intentWeights,
    officerAbilities,
    intents,
  };
}

/**
 * Manager for fetching and caching the effect bundle in the web app.
 */
export class EffectBundleManager {
  private cached: EffectBundleData | null = null;
  private error: Error | null = null;
  private loading = false;
  private listeners: Array<() => void> = [];

  /**
   * Fetch the bundle once and cache it.
   */
  async load(): Promise<EffectBundleData> {
    if (this.cached) return this.cached;
    if (this.error) throw this.error;
    if (this.loading) {
      // Wait for loading to complete
      return new Promise((resolve, reject) => {
        this.listeners.push(() => {
          if (this.cached) resolve(this.cached);
          else if (this.error) reject(this.error);
        });
      });
    }

    this.loading = true;
    try {
      const raw = await fetchEffectBundle();
      this.cached = adaptEffectBundle(raw);
      this.loading = false;
      this.notifyListeners();
      return this.cached;
    } catch (err) {
      this.error = err instanceof Error ? err : new Error(String(err));
      this.loading = false;
      this.notifyListeners();
      throw this.error;
    }
  }

  get(): EffectBundleData | null {
    return this.cached;
  }

  hasError(): boolean {
    return this.error !== null;
  }

  getError(): Error | null {
    return this.error;
  }

  isLoading(): boolean {
    return this.loading;
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      listener();
    }
    this.listeners = [];
  }
}

// Global instance
let managerInstance: EffectBundleManager | null = null;

export function getEffectBundleManager(): EffectBundleManager {
  if (!managerInstance) {
    managerInstance = new EffectBundleManager();
  }
  return managerInstance;
}
