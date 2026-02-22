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
import phraseMapV0 from "./data/phrase-map.v0.json";
import intentVectorsV0 from "./data/intent-vectors.v0.json";

export type MappingIssueType = "unmapped_ability_text" | "unknown_magnitude";

export interface EffectMappingIssue {
  type: MappingIssueType;
  abilityId: string;
  officerId: string;
  detail: string;
}

export interface EffectMappingTelemetry {
  totalAbilities: number;
  mappedAbilities: number;
  mappedPercent: number;
  unknownMagnitudeEffects: number;
  topUnmappedAbilityPhrases: string[];
}

export interface PhraseMapCoverage {
  totalPhrases: number;
  mappedPhrases: number;
  mappedPercent: number;
  topUnmappedPhrases: string[];
}

interface PhraseMapRule {
  id: string;
  match_any: string[];
}

interface PhraseMapEffect {
  id: string;
  match_any: string[];
  effectKey: string;
  unit?: string;
}

interface PhraseMapArtifact {
  rules: PhraseMapRule[];
  effects: PhraseMapEffect[];
  meta_effects?: PhraseMapEffect[];
}

interface IntentVectorDef {
  intentKey: string;
  label: string;
  defaultTargetContext: TargetContext;
  weights: Record<string, number>;
}

interface IntentVectorArtifact {
  intents: IntentVectorDef[];
}

const PHRASE_MAP = phraseMapV0 as PhraseMapArtifact;

function parseIntentVectorArtifact(value: unknown): IntentVectorArtifact {
  if (!isObject(value) || !Array.isArray(value.intents)) {
    return { intents: [] };
  }

  const intents: IntentVectorDef[] = [];
  for (const rawIntent of value.intents) {
    if (!isObject(rawIntent)) continue;

    const intentKey = typeof rawIntent.intentKey === "string" ? rawIntent.intentKey : null;
    const label = typeof rawIntent.label === "string" ? rawIntent.label : null;
    const defaultTargetContext = parseTargetContext(rawIntent.defaultTargetContext);
    const weights = parseNumericRecord(rawIntent.weights);

    if (!intentKey || !label || !defaultTargetContext) continue;

    intents.push({
      intentKey,
      label,
      defaultTargetContext,
      weights,
    });
  }

  return { intents };
}

function parseNumericRecord(value: unknown): Record<string, number> {
  if (!isObject(value)) return {};
  const parsed: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      parsed[key] = raw;
    }
  }
  return parsed;
}

function parseTargetContext(value: unknown): TargetContext | null {
  if (!isObject(value)) return null;
  const targetKind = typeof value.targetKind === "string" ? value.targetKind : null;
  const engagement = typeof value.engagement === "string" ? value.engagement : null;
  const targetTags = Array.isArray(value.targetTags) ? value.targetTags.filter((tag): tag is string => typeof tag === "string") : [];

  if (!targetKind || !engagement) return null;

  return {
    targetKind: targetKind as TargetContext["targetKind"],
    engagement: engagement as TargetContext["engagement"],
    targetTags,
  };
}

const INTENT_VECTORS = parseIntentVectorArtifact(intentVectorsV0);

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

interface ApiSuccessEnvelope<T> {
  ok: true;
  data: T;
  meta?: unknown;
}

interface ApiErrorEnvelope {
  ok: false;
  error?: { message?: string };
  meta?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEffectBundleResponse(value: unknown): value is EffectBundleResponse {
  if (!isObject(value)) return false;
  return Array.isArray(value.intents) && isObject(value.officers);
}

function isApiSuccessEnvelope(value: unknown): value is ApiSuccessEnvelope<unknown> {
  return isObject(value) && value.ok === true && "data" in value;
}

function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  return isObject(value) && value.ok === false;
}

function unwrapEffectBundlePayload(payload: unknown): EffectBundleResponse {
  if (isEffectBundleResponse(payload)) {
    return payload;
  }

  if (isApiSuccessEnvelope(payload)) {
    const data = payload.data;
    if (isEffectBundleResponse(data)) {
      return data;
    }
    throw new Error("Malformed effect bundle payload in envelope: expected data.intents[] and data.officers{}");
  }

  if (isApiErrorEnvelope(payload)) {
    const errorMessage = payload.error?.message ?? "Unknown API error";
    throw new Error(`Effect bundle request failed: ${errorMessage}`);
  }

  throw new Error("Malformed effect bundle response: expected bundle object or AX envelope");
}

/**
 * Parsed bundle with intent weights and officer abilities indexed for easy lookup.
 */
export interface EffectBundleData {
  schemaVersion: string;
  intentWeights: Map<string, Record<string, number>>;
  officerAbilities: Map<string, OfficerAbility[]>;
  intents: Map<string, IntentDefinition>;
  mappingIssues: EffectMappingIssue[];
  mappingTelemetry: EffectMappingTelemetry;
}

export function normalizePhrase(input: string): string {
  return input
    .toLowerCase()
    .replace(/non\s+player/g, "non-player")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseMatchesAny(normalized: string, candidates: string[]): boolean {
  return candidates.some((candidate) => normalized.includes(normalizePhrase(candidate)));
}

function hasPhraseMapMatch(phrase: string): boolean {
  const normalized = normalizePhrase(phrase);
  if (!normalized) return false;
  if (PHRASE_MAP.rules.some((rule) => phraseMatchesAny(normalized, rule.match_any))) return true;
  if (PHRASE_MAP.effects.some((effect) => phraseMatchesAny(normalized, effect.match_any))) return true;
  if ((PHRASE_MAP.meta_effects ?? []).some((effect) => phraseMatchesAny(normalized, effect.match_any))) return true;
  return false;
}

export function getPhraseMapCoverage(
  phrases: string[],
): PhraseMapCoverage {
  const unmappedCounts = new Map<string, number>();
  let mappedPhrases = 0;

  for (const phrase of phrases) {
    const normalized = normalizePhrase(phrase);
    if (!normalized) continue;
    if (hasPhraseMapMatch(normalized)) {
      mappedPhrases += 1;
      continue;
    }
    unmappedCounts.set(normalized, (unmappedCounts.get(normalized) ?? 0) + 1);
  }

  const topUnmappedPhrases = [...unmappedCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);

  const totalPhrases = phrases.length;
  const mappedPercent = totalPhrases > 0 ? Math.round((mappedPhrases / totalPhrases) * 1000) / 10 : 100;

  return {
    totalPhrases,
    mappedPhrases,
    mappedPercent,
    topUnmappedPhrases,
  };
}

function applyCanonicalIntentVectors(
  intentWeights: Map<string, Record<string, number>>,
  intents: Map<string, IntentDefinition>,
): void {
  for (const vector of INTENT_VECTORS.intents) {
    intentWeights.set(vector.intentKey, vector.weights);
    intents.set(vector.intentKey, {
      id: vector.intentKey,
      name: vector.label,
      description: vector.label,
      defaultContext: vector.defaultTargetContext,
      effectWeights: vector.weights,
    });
  }
}

/**
 * Fetch and parse the effect bundle from the server.
 */
export async function fetchEffectBundle(): Promise<EffectBundleResponse> {
  const response = await fetch("/api/effects/bundle", {
    method: "GET",
    headers: { "Accept": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch effect bundle: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return unwrapEffectBundlePayload(payload);
}

/**
 * Adapt a raw EffectBundleResponse into indexed Maps for the recommender.
 */
export function adaptEffectBundle(raw: EffectBundleResponse): EffectBundleData {
  const intentWeights = new Map<string, Record<string, number>>();
  const officerAbilities = new Map<string, OfficerAbility[]>();
  const intents = new Map<string, IntentDefinition>();
  const mappingIssues: EffectMappingIssue[] = [];
  let totalAbilities = 0;
  let mappedAbilities = 0;
  let unknownMagnitudeEffects = 0;
  const unmappedAbilityPhraseCounts = new Map<string, number>();

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
    const abilities: OfficerAbility[] = officerData.abilities.map((ab) => {
      totalAbilities += 1;
      return {
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
      };
    });

    for (const ability of abilities) {
      if (ability.effects.length > 0) {
        mappedAbilities += 1;
      } else {
        const phrase = normalizePhrase(ability.rawText ?? "");
        if (phrase && !hasPhraseMapMatch(phrase)) {
          unmappedAbilityPhraseCounts.set(phrase, (unmappedAbilityPhraseCounts.get(phrase) ?? 0) + 1);
          mappingIssues.push({
            type: "unmapped_ability_text",
            abilityId: ability.id,
            officerId,
            detail: ability.rawText ?? "",
          });
        }
      }

      for (const effect of ability.effects) {
        if (effect.magnitude == null) {
          unknownMagnitudeEffects += 1;
          mappingIssues.push({
            type: "unknown_magnitude",
            abilityId: ability.id,
            officerId,
            detail: effect.effectKey,
          });
        }
      }
    }

    officerAbilities.set(officerId, abilities);
  }

  applyCanonicalIntentVectors(intentWeights, intents);

  const topUnmappedAbilityPhrases = [...unmappedAbilityPhraseCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);

  const mappingTelemetry: EffectMappingTelemetry = {
    totalAbilities,
    mappedAbilities,
    mappedPercent: totalAbilities > 0 ? Math.round((mappedAbilities / totalAbilities) * 1000) / 10 : 100,
    unknownMagnitudeEffects,
    topUnmappedAbilityPhrases,
  };

  return {
    schemaVersion: raw.schemaVersion,
    intentWeights,
    officerAbilities,
    intents,
    mappingIssues,
    mappingTelemetry,
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
    this.error = null;
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
