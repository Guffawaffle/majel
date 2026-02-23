import { createHash } from "node:crypto";
import type { SeedAbilityInput, SeedIntentInput, SeedTaxonomyData } from "../stores/effect-store.js";

const SLOT_ORDER: Record<string, number> = { cm: 0, oa: 1, bda: 2 };

export interface EffectsSeedFile {
  taxonomy: SeedTaxonomyData;
  intents: SeedIntentInput[];
  officers: (SeedAbilityInput & { _comment?: string })[];
}

export interface EffectsContractIssue {
  severity: "error" | "warn";
  path: string;
  message: string;
}

export interface EffectsContractValidationResult {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: EffectsContractIssue[];
}

export interface EffectsContractArtifact {
  schemaVersion: string;
  artifactVersion: string;
  generatedAt: string;
  source: {
    snapshotVersion: string;
    locale: string;
    generatorVersion: string;
  };
  taxonomyRef: {
    version: string;
    canonicalization: string;
    slotsDigest: string;
    effectKeysDigest: string;
    conditionKeysDigest: string;
    targetKindsDigest: string;
    targetTagsDigest: string;
    shipClassesDigest: string;
    issueTypesDigest: string;
  };
  officers: EffectsContractOfficer[];
}

export interface EffectsContractOfficer {
  officerId: string;
  officerName: string;
  abilities: EffectsContractAbility[];
}

export interface EffectsContractAbility {
  abilityId: string;
  slot: "cm" | "oa" | "bda";
  isInert: boolean;
  inertReason: "no_effect" | "not_applicable" | "unknown" | null;
  name: string | null;
  rawText: string;
  effects: EffectsContractEffect[];
  unmapped: EffectsContractUnmapped[];
}

export interface EffectsContractEffect {
  effectId: string;
  effectKey: string;
  magnitude: number | null;
  unit: string | null;
  stacking: string | null;
  targets: {
    targetKinds: string[];
    targetTags: string[];
    shipClass: string | null;
  };
  conditions: { conditionKey: string; params: Record<string, string> | null }[];
  extraction: {
    method: "deterministic" | "inferred" | "overridden";
    ruleId: string;
    model: string | null;
    promptVersion: string | null;
    inputDigest: string;
  };
  inferred: boolean;
  promotionReceiptId: string | null;
  confidence: {
    score: number;
    tier: "high" | "medium" | "low";
    forcedByOverride: boolean;
  };
  evidence: EffectsContractEvidence[];
}

export interface EffectsOverrideFile {
  schemaVersion: "1.0.0";
  artifactBase: string;
  operations: EffectsOverrideOperation[];
}

export interface EffectsOverrideOperation {
  op: "replace_effect";
  target: {
    abilityId: string;
    effectId: string;
  };
  value: Omit<EffectsContractEffect, "effectId">;
  reason: string;
  author: string;
  ticket?: string;
}

export interface EffectsContractEvidence {
  sourceRef: string;
  snippet: string;
  ruleId: string;
  sourceLocale: "en";
  sourcePath: "effect-taxonomy.json";
  sourceOffset: number;
}

export interface EffectsContractUnmapped {
  type: "unmapped_ability_text" | "unknown_effect_key";
  severity: "warn";
  reason: string;
  confidence: number;
  evidence: EffectsContractEvidence[];
}

export interface BuildEffectsContractOptions {
  generatedAt?: string;
  snapshotVersion?: string;
  generatorVersion?: string;
}

interface SeedSourceSpan {
  start: number;
  end: number;
}

interface SeedEffectWithSourceMeta {
  id: string;
  effectKey: string;
  magnitude?: number | null;
  unit?: string | null;
  stacking?: string | null;
  targetKinds?: string[];
  targetTags?: string[];
  conditions?: { conditionKey: string; params?: Record<string, string> | null }[];
  sourceRef?: string;
  sourceSpan?: SeedSourceSpan;
  sourceSegment?: string;
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted = Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableNormalize(obj[key]);
        return acc;
      }, {});
    return sorted;
  }
  return value;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function digestTaxonomyPart(value: unknown): string {
  return `sha256:${sha256Hex(stableJsonStringify(value))}`;
}

function sortedUniqueStrings(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((a, b) => a.localeCompare(b));
}

function buildEffectSourceLocator(abilitySeedId: string, effect: SeedEffectWithSourceMeta): {
  sourceRef: string;
  sortKey: string;
  sourceOffset: number;
} {
  if (effect.sourceRef && effect.sourceRef.trim().length > 0) {
    return {
      sourceRef: effect.sourceRef,
      sortKey: `ref:${effect.sourceRef}`,
      sourceOffset: 0,
    };
  }

  if (
    effect.sourceSpan
    && Number.isInteger(effect.sourceSpan.start)
    && Number.isInteger(effect.sourceSpan.end)
    && effect.sourceSpan.start >= 0
    && effect.sourceSpan.end >= effect.sourceSpan.start
  ) {
    const { start, end } = effect.sourceSpan;
    return {
      sourceRef: `effect-taxonomy.officer-fixture.v1.json#/officers/byAbilityId/${abilitySeedId}/rawText/spans/${start}-${end}`,
      sortKey: `span:${String(start).padStart(8, "0")}:${String(end).padStart(8, "0")}`,
      sourceOffset: start,
    };
  }

  if (effect.sourceSegment && effect.sourceSegment.trim().length > 0) {
    const seg = effect.sourceSegment.trim();
    return {
      sourceRef: `effect-taxonomy.officer-fixture.v1.json#/officers/byAbilityId/${abilitySeedId}/rawText/segments/${encodeURIComponent(seg)}`,
      sortKey: `seg:${seg}`,
      sourceOffset: 0,
    };
  }

  return {
    sourceRef: `effect-taxonomy.officer-fixture.v1.json#/officers/byAbilityId/${abilitySeedId}/effects/${effect.id}`,
    sortKey: `fallback:${effect.id}`,
    sourceOffset: 0,
  };
}

function deriveInertReason(isInert: boolean, rawText: string): "no_effect" | "not_applicable" | "unknown" | null {
  if (!isInert) return null;
  const normalized = rawText.toLowerCase();
  if (normalized.includes("not applicable") || normalized.includes("cannot be used")) return "not_applicable";
  if (normalized.includes("no effect") || normalized.includes("does nothing") || normalized.includes("inert")) return "no_effect";
  return "unknown";
}

export function orderSeedForDeterminism(seed: EffectsSeedFile): EffectsSeedFile {
  return {
    taxonomy: {
      ...seed.taxonomy,
      targetKinds: sortedUniqueStrings(seed.taxonomy.targetKinds),
      targetTags: sortedUniqueStrings(seed.taxonomy.targetTags),
      shipClasses: sortedUniqueStrings(seed.taxonomy.shipClasses),
      slots: sortedUniqueStrings(seed.taxonomy.slots),
      effectKeys: [...seed.taxonomy.effectKeys].sort((a, b) => a.id.localeCompare(b.id)),
      conditionKeys: [...seed.taxonomy.conditionKeys].sort((a, b) => a.id.localeCompare(b.id)),
      issueTypes: [...seed.taxonomy.issueTypes].sort((a, b) => a.id.localeCompare(b.id)),
    },
    intents: [...seed.intents].sort((a, b) => a.id.localeCompare(b.id)).map((intent) => ({
      ...intent,
      defaultContext: intent.defaultContext
        ? {
          ...intent.defaultContext,
          targetTags: sortedUniqueStrings(intent.defaultContext.targetTags),
        }
        : undefined,
      effectWeights: [...intent.effectWeights].sort((a, b) => a.effectKey.localeCompare(b.effectKey)),
    })),
    officers: [...seed.officers]
      .map(({ _comment, ...ability }) => ({ ...ability }))
      .sort((a, b) => {
        const officerCmp = a.officerId.localeCompare(b.officerId);
        if (officerCmp !== 0) return officerCmp;
        const slotCmp = (SLOT_ORDER[a.slot] ?? 99) - (SLOT_ORDER[b.slot] ?? 99);
        if (slotCmp !== 0) return slotCmp;
        return a.id.localeCompare(b.id);
      })
      .map((ability) => ({
        ...ability,
        effects: [...ability.effects]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((effect) => ({
            ...effect,
            targetKinds: sortedUniqueStrings(effect.targetKinds),
            targetTags: sortedUniqueStrings(effect.targetTags),
            conditions: [...(effect.conditions ?? [])]
              .sort((a, b) => a.conditionKey.localeCompare(b.conditionKey))
              .map((condition) => ({
                ...condition,
                params: condition.params
                  ? Object.keys(condition.params)
                    .sort()
                    .reduce<Record<string, string>>((acc, key) => {
                      acc[key] = condition.params![key]!;
                      return acc;
                    }, {})
                  : null,
              })),
          })),
      })),
  };
}

export function validateEffectsSeedForV3(seed: EffectsSeedFile): EffectsContractValidationResult {
  const issues: EffectsContractIssue[] = [];

  const pushIssue = (severity: "error" | "warn", path: string, message: string) => {
    issues.push({ severity, path, message });
  };

  const checkDuplicateIds = (values: string[], path: string) => {
    const seen = new Set<string>();
    for (let index = 0; index < values.length; index++) {
      const id = values[index];
      if (seen.has(id)) {
        pushIssue("error", `${path}[${index}]`, `Duplicate id '${id}'`);
      }
      seen.add(id);
    }
  };

  checkDuplicateIds(seed.taxonomy.targetKinds, "taxonomy.targetKinds");
  checkDuplicateIds(seed.taxonomy.targetTags, "taxonomy.targetTags");
  checkDuplicateIds(seed.taxonomy.shipClasses, "taxonomy.shipClasses");
  checkDuplicateIds(seed.taxonomy.slots, "taxonomy.slots");
  checkDuplicateIds(seed.taxonomy.effectKeys.map((x) => x.id), "taxonomy.effectKeys");
  checkDuplicateIds(seed.taxonomy.conditionKeys.map((x) => x.id), "taxonomy.conditionKeys");
  checkDuplicateIds(seed.taxonomy.issueTypes.map((x) => x.id), "taxonomy.issueTypes");

  const effectKeySet = new Set(seed.taxonomy.effectKeys.map((x) => x.id));
  const conditionKeySet = new Set(seed.taxonomy.conditionKeys.map((x) => x.id));
  const targetKindSet = new Set(seed.taxonomy.targetKinds);
  const targetTagSet = new Set(seed.taxonomy.targetTags);
  const shipClassSet = new Set(seed.taxonomy.shipClasses);

  const intentIds = new Set<string>();
  seed.intents.forEach((intent, intentIndex) => {
    if (intentIds.has(intent.id)) {
      pushIssue("error", `intents[${intentIndex}].id`, `Duplicate intent id '${intent.id}'`);
    }
    intentIds.add(intent.id);

    intent.effectWeights.forEach((weight, weightIndex) => {
      if (!effectKeySet.has(weight.effectKey)) {
        pushIssue(
          "error",
          `intents[${intentIndex}].effectWeights[${weightIndex}].effectKey`,
          `Unknown taxonomy effectKey '${weight.effectKey}'`,
        );
      }
      if (!Number.isFinite(weight.weight)) {
        pushIssue(
          "error",
          `intents[${intentIndex}].effectWeights[${weightIndex}].weight`,
          "Intent weight must be a finite number",
        );
      }
    });

    if (intent.defaultContext) {
      if (!targetKindSet.has(intent.defaultContext.targetKind)) {
        pushIssue(
          "error",
          `intents[${intentIndex}].defaultContext.targetKind`,
          `Unknown targetKind '${intent.defaultContext.targetKind}'`,
        );
      }
      for (let i = 0; i < (intent.defaultContext.targetTags ?? []).length; i++) {
        const tag = intent.defaultContext.targetTags?.[i];
        if (tag && !targetTagSet.has(tag)) {
          pushIssue(
            "error",
            `intents[${intentIndex}].defaultContext.targetTags[${i}]`,
            `Unknown targetTag '${tag}'`,
          );
        }
      }
      if (intent.defaultContext.shipClass && !shipClassSet.has(intent.defaultContext.shipClass)) {
        pushIssue(
          "error",
          `intents[${intentIndex}].defaultContext.shipClass`,
          `Unknown shipClass '${intent.defaultContext.shipClass}'`,
        );
      }
    }
  });

  const abilityIds = new Set<string>();
  const effectIds = new Set<string>();

  seed.officers.forEach((ability, abilityIndex) => {
    if (abilityIds.has(ability.id)) {
      pushIssue("error", `officers[${abilityIndex}].id`, `Duplicate ability id '${ability.id}'`);
    }
    abilityIds.add(ability.id);

    if (!/^cdn:officer:\d+$/.test(ability.officerId)) {
      pushIssue(
        "error",
        `officers[${abilityIndex}].officerId`,
        `officerId must use numeric CDN format (received '${ability.officerId}')`,
      );
    }

    if (!(ability.slot in SLOT_ORDER)) {
      pushIssue("error", `officers[${abilityIndex}].slot`, `Unknown slot '${ability.slot}'`);
    }

    if (ability.rawText === null || ability.rawText.trim().length === 0) {
      pushIssue("error", `officers[${abilityIndex}].rawText`, "rawText is required for v3 contract generation");
    }

    if (ability.isInert && ability.effects.length > 0) {
      pushIssue(
        "error",
        `officers[${abilityIndex}].effects`,
        "Inert abilities must not include normalized effects",
      );
    }

    if (!ability.isInert && ability.effects.length === 0) {
      pushIssue(
        "warn",
        `officers[${abilityIndex}].effects`,
        "Non-inert ability has no normalized effects; generator will emit unmapped entry",
      );
    }

    ability.effects.forEach((effect, effectIndex) => {
      if (effectIds.has(effect.id)) {
        pushIssue(
          "error",
          `officers[${abilityIndex}].effects[${effectIndex}].id`,
          `Duplicate effect id '${effect.id}'`,
        );
      }
      effectIds.add(effect.id);

      if (!effectKeySet.has(effect.effectKey)) {
        pushIssue(
          "error",
          `officers[${abilityIndex}].effects[${effectIndex}].effectKey`,
          `Unknown taxonomy effectKey '${effect.effectKey}'`,
        );
      }

      (effect.targetKinds ?? []).forEach((targetKind, targetKindIndex) => {
        if (!targetKindSet.has(targetKind)) {
          pushIssue(
            "error",
            `officers[${abilityIndex}].effects[${effectIndex}].targetKinds[${targetKindIndex}]`,
            `Unknown targetKind '${targetKind}'`,
          );
        }
      });

      (effect.targetTags ?? []).forEach((targetTag, targetTagIndex) => {
        if (!targetTagSet.has(targetTag)) {
          pushIssue(
            "error",
            `officers[${abilityIndex}].effects[${effectIndex}].targetTags[${targetTagIndex}]`,
            `Unknown targetTag '${targetTag}'`,
          );
        }
      });

      (effect.conditions ?? []).forEach((condition, conditionIndex) => {
        if (!conditionKeySet.has(condition.conditionKey)) {
          pushIssue(
            "error",
            `officers[${abilityIndex}].effects[${effectIndex}].conditions[${conditionIndex}].conditionKey`,
            `Unknown conditionKey '${condition.conditionKey}'`,
          );
        }
      });
    });
  });

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warn").length;
  return {
    ok: errors === 0,
    errors,
    warnings,
    issues,
  };
}

export function buildEffectsContractV3Artifact(
  seedInput: EffectsSeedFile,
  options: BuildEffectsContractOptions = {},
): EffectsContractArtifact {
  const seed = orderSeedForDeterminism(seedInput);
  const effectKeySet = new Set(seed.taxonomy.effectKeys.map((effectKey) => effectKey.id));

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const snapshotVersion = options.snapshotVersion ?? "stfc-seed-v0";
  const generatorVersion = options.generatorVersion ?? "0.1.0";

  const grouped = new Map<string, (SeedAbilityInput & { _comment?: string })[]>();
  for (const ability of seed.officers) {
    const arr = grouped.get(ability.officerId) ?? [];
    arr.push(ability);
    grouped.set(ability.officerId, arr);
  }

  const officers: EffectsContractOfficer[] = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([officerId, abilities]) => ({
      officerId,
      officerName: officerId,
      abilities: abilities
        .sort((a, b) => {
          const slotCmp = (SLOT_ORDER[a.slot] ?? 99) - (SLOT_ORDER[b.slot] ?? 99);
          if (slotCmp !== 0) return slotCmp;
          return a.id.localeCompare(b.id);
        })
        .map((ability) => {
          const abilityId = `${officerId}:${ability.slot}`;
          const rawText = ability.rawText ?? "";
          const effectsWithLocator = (ability.effects as SeedEffectWithSourceMeta[]).map((effect) => ({
            effect,
            locator: buildEffectSourceLocator(ability.id, effect),
          }));

          const sortedEffects = effectsWithLocator.sort((a, b) => {
            const sourceCmp = a.locator.sortKey.localeCompare(b.locator.sortKey);
            if (sourceCmp !== 0) return sourceCmp;
            return a.effect.id.localeCompare(b.effect.id);
          });

          const effects: EffectsContractEffect[] = [];
          const unmapped: EffectsContractUnmapped[] = [];

          for (let sourceSpanIndex = 0; sourceSpanIndex < sortedEffects.length; sourceSpanIndex++) {
            const { effect, locator } = sortedEffects[sourceSpanIndex];
            const sourceRef = locator.sourceRef;

            if (!effectKeySet.has(effect.effectKey)) {
              unmapped.push({
                type: "unknown_effect_key",
                severity: "warn",
                reason: `Unknown taxonomy effectKey '${effect.effectKey}'`,
                confidence: 0,
                evidence: [{
                  sourceRef,
                  snippet: rawText,
                  ruleId: "seed_contract_v0",
                  sourceLocale: "en",
                  sourcePath: "effect-taxonomy.json",
                  sourceOffset: locator.sourceOffset,
                }],
              });
              continue;
            }

            const inputDigest = `sha256:${sha256Hex(`${rawText}:${sourceRef}:${effect.id}`)}`;
            effects.push({
              effectId: `${abilityId}:ef:src-${sourceSpanIndex}`,
              effectKey: effect.effectKey,
              magnitude: effect.magnitude ?? null,
              unit: effect.unit ?? null,
              stacking: effect.stacking ?? null,
              targets: {
                targetKinds: sortedUniqueStrings(effect.targetKinds),
                targetTags: sortedUniqueStrings(effect.targetTags),
                shipClass: null,
              },
              conditions: [...(effect.conditions ?? [])]
                .sort((a, b) => a.conditionKey.localeCompare(b.conditionKey))
                .map((condition) => ({
                  conditionKey: condition.conditionKey,
                  params: condition.params ?? null,
                })),
              extraction: {
                method: "deterministic",
                ruleId: "seed_contract_v0",
                model: null,
                promptVersion: null,
                inputDigest,
              },
              inferred: false,
              promotionReceiptId: null,
              confidence: {
                score: 1,
                tier: "high",
                forcedByOverride: false,
              },
              evidence: [{
                sourceRef,
                snippet: rawText,
                ruleId: "seed_contract_v0",
                sourceLocale: "en",
                sourcePath: "effect-taxonomy.json",
                sourceOffset: locator.sourceOffset,
              }],
            });
          }

          if (!ability.isInert && effects.length === 0 && unmapped.length === 0) {
            unmapped.push({
              type: "unmapped_ability_text",
              severity: "warn",
              reason: "No deterministic mapping was present in the seed effects list",
              confidence: 0,
              evidence: [{
                sourceRef: `effect-taxonomy.officer-fixture.v1.json#/officers/byAbilityId/${ability.id}`,
                snippet: rawText,
                ruleId: "seed_contract_v0",
                sourceLocale: "en",
                sourcePath: "effect-taxonomy.json",
                sourceOffset: 0,
              }],
            });
          }

          return {
            abilityId,
            slot: ability.slot,
            isInert: ability.isInert,
            inertReason: deriveInertReason(ability.isInert, rawText),
            name: ability.name,
            rawText,
            effects,
            unmapped,
          };
        }),
    }));

  const artifact: EffectsContractArtifact = {
    schemaVersion: "1.0.0",
    artifactVersion: "1.0.0+sha256:pending",
    generatedAt,
    source: {
      snapshotVersion,
      locale: "en",
      generatorVersion,
    },
    taxonomyRef: {
      version: "1.0.0",
      canonicalization: "stable-json-v1(sorted keys, UTF-8)",
      slotsDigest: digestTaxonomyPart(seed.taxonomy.slots),
      effectKeysDigest: digestTaxonomyPart(seed.taxonomy.effectKeys),
      conditionKeysDigest: digestTaxonomyPart(seed.taxonomy.conditionKeys),
      targetKindsDigest: digestTaxonomyPart(seed.taxonomy.targetKinds),
      targetTagsDigest: digestTaxonomyPart(seed.taxonomy.targetTags),
      shipClassesDigest: digestTaxonomyPart(seed.taxonomy.shipClasses),
      issueTypesDigest: digestTaxonomyPart(seed.taxonomy.issueTypes),
    },
    officers,
  };

  const hash = hashEffectsContractArtifact(artifact);
  artifact.artifactVersion = `1.0.0+sha256:${hash.slice(0, 16)}`;
  return artifact;
}

export function hashEffectsContractArtifact(artifact: EffectsContractArtifact): string {
  return sha256Hex(stableJsonStringify(artifact));
}

export function summarizeEffectsContractArtifact(artifact: EffectsContractArtifact): {
  officers: number;
  abilities: number;
  effects: number;
  inertAbilities: number;
  unmappedEntries: number;
} {
  let abilities = 0;
  let effects = 0;
  let inertAbilities = 0;
  let unmappedEntries = 0;

  for (const officer of artifact.officers) {
    abilities += officer.abilities.length;
    for (const ability of officer.abilities) {
      effects += ability.effects.length;
      if (ability.isInert) inertAbilities++;
      unmappedEntries += ability.unmapped.length;
    }
  }

  return {
    officers: artifact.officers.length,
    abilities,
    effects,
    inertAbilities,
    unmappedEntries,
  };
}

function validateOverrideEffectTaxonomy(
  effect: Omit<EffectsContractEffect, "effectId">,
  taxonomy: EffectsSeedFile["taxonomy"],
): string[] {
  const issues: string[] = [];
  const effectKeySet = new Set(taxonomy.effectKeys.map((entry) => entry.id));
  const targetKindSet = new Set(taxonomy.targetKinds);
  const targetTagSet = new Set(taxonomy.targetTags);
  const conditionKeySet = new Set(taxonomy.conditionKeys.map((entry) => entry.id));
  const shipClassSet = new Set(taxonomy.shipClasses);

  if (!effectKeySet.has(effect.effectKey)) {
    issues.push(`Unknown override effectKey '${effect.effectKey}'`);
  }

  for (const targetKind of effect.targets.targetKinds) {
    if (!targetKindSet.has(targetKind)) {
      issues.push(`Unknown override targetKind '${targetKind}'`);
    }
  }

  for (const targetTag of effect.targets.targetTags) {
    if (!targetTagSet.has(targetTag)) {
      issues.push(`Unknown override targetTag '${targetTag}'`);
    }
  }

  if (effect.targets.shipClass !== null && !shipClassSet.has(effect.targets.shipClass)) {
    issues.push(`Unknown override shipClass '${effect.targets.shipClass}'`);
  }

  for (const condition of effect.conditions) {
    if (!conditionKeySet.has(condition.conditionKey)) {
      issues.push(`Unknown override conditionKey '${condition.conditionKey}'`);
    }
  }

  return issues;
}

function effectSignature(effect: EffectsContractEffect): string {
  return stableJsonStringify({
    effectKey: effect.effectKey,
    magnitude: effect.magnitude,
    unit: effect.unit,
    stacking: effect.stacking,
    targets: effect.targets,
    conditions: effect.conditions,
  });
}

function inferSpanIndexFromEffectId(effectId: string): string | null {
  const match = effectId.match(/:ef:src-(\d+)$/);
  if (!match?.[1]) return null;
  return match[1];
}

function assertNoOverrideContradictions(artifact: EffectsContractArtifact): void {
  const globalEffectIds = new Set<string>();

  for (const officer of artifact.officers) {
    for (const ability of officer.abilities) {
      const signatureToEffectId = new Map<string, string>();
      const sourceSpanToEffect = new Map<string, { effectKey: string; magnitude: number | null }>();

      for (const effect of ability.effects) {
        if (globalEffectIds.has(effect.effectId)) {
          throw new Error(`Override contradiction: duplicate effectId '${effect.effectId}'`);
        }
        globalEffectIds.add(effect.effectId);

        const signature = effectSignature(effect);
        const existingEffectId = signatureToEffectId.get(signature);
        if (existingEffectId && existingEffectId !== effect.effectId) {
          throw new Error(
            `Override contradiction: ability '${ability.abilityId}' has duplicate effect signature between '${existingEffectId}' and '${effect.effectId}'`,
          );
        }
        signatureToEffectId.set(signature, effect.effectId);

        const sourceRef = effect.evidence[0]?.sourceRef ?? "unknown";
        const spanIndex = inferSpanIndexFromEffectId(effect.effectId);
        if (!spanIndex) continue;

        const spanKey = `${sourceRef}#${spanIndex}`;
        const prior = sourceSpanToEffect.get(spanKey);
        if (prior && (prior.effectKey !== effect.effectKey || prior.magnitude !== effect.magnitude)) {
          throw new Error(
            `Intra-ability contradiction: ability '${ability.abilityId}' has conflicting override values at source span '${spanKey}'`,
          );
        }
        sourceSpanToEffect.set(spanKey, {
          effectKey: effect.effectKey,
          magnitude: effect.magnitude,
        });
      }
    }
  }
}

export function applyEffectsOverridesToArtifact(
  artifactInput: EffectsContractArtifact,
  overrides: EffectsOverrideFile,
  taxonomy: EffectsSeedFile["taxonomy"],
): EffectsContractArtifact {
  if (overrides.schemaVersion !== "1.0.0") {
    throw new Error(`Invalid overrides schemaVersion '${overrides.schemaVersion}'`);
  }

  if (overrides.artifactBase !== "*" && overrides.artifactBase !== artifactInput.artifactVersion) {
    throw new Error(
      `Override artifactBase mismatch: expected '${artifactInput.artifactVersion}' or '*', got '${overrides.artifactBase}'`,
    );
  }

  const artifact = JSON.parse(JSON.stringify(artifactInput)) as EffectsContractArtifact;
  const operations = [...overrides.operations].sort((left, right) => {
    const abilityCmp = left.target.abilityId.localeCompare(right.target.abilityId);
    if (abilityCmp !== 0) return abilityCmp;
    return left.target.effectId.localeCompare(right.target.effectId);
  });

  const seenTargets = new Set<string>();

  for (const operation of operations) {
    if (operation.op !== "replace_effect") {
      throw new Error(`Unsupported override op '${operation.op}'`);
    }

    const targetKey = `${operation.target.abilityId}:${operation.target.effectId}`;
    if (seenTargets.has(targetKey)) {
      throw new Error(`Override contradiction: duplicate mutation target '${targetKey}'`);
    }
    seenTargets.add(targetKey);

    const taxonomyIssues = validateOverrideEffectTaxonomy(operation.value, taxonomy);
    if (taxonomyIssues.length > 0) {
      throw new Error(`Override taxonomy contradiction for '${targetKey}': ${taxonomyIssues.join("; ")}`);
    }

    if (operation.value.evidence.length === 0) {
      throw new Error(`Override '${targetKey}' must include at least one evidence item`);
    }

    const officer = artifact.officers.find((entry) => (
      entry.abilities.some((ability) => ability.abilityId === operation.target.abilityId)
    ));
    const ability = officer?.abilities.find((entry) => entry.abilityId === operation.target.abilityId);
    if (!ability) {
      throw new Error(`Override target ability not found: '${operation.target.abilityId}'`);
    }

    const effectIndex = ability.effects.findIndex((effect) => effect.effectId === operation.target.effectId);
    if (effectIndex < 0) {
      throw new Error(
        `Override target effect not found: ability='${operation.target.abilityId}' effect='${operation.target.effectId}'`,
      );
    }

    const inputDigest = operation.value.extraction.inputDigest
      || `sha256:${sha256Hex(stableJsonStringify({
        target: operation.target,
        value: operation.value,
        reason: operation.reason,
        author: operation.author,
        ticket: operation.ticket ?? null,
      }))}`;

    const valueWithoutEffectId = operation.value as Omit<EffectsContractEffect, "effectId"> & { effectId?: string };

    const replacement: EffectsContractEffect = {
      ...valueWithoutEffectId,
      effectId: operation.target.effectId,
      extraction: {
        ...operation.value.extraction,
        method: "overridden",
        ruleId: operation.value.extraction.ruleId || "override",
        inputDigest,
      },
      inferred: false,
      promotionReceiptId: null,
      confidence: {
        ...operation.value.confidence,
        forcedByOverride: true,
      },
    };

    ability.effects[effectIndex] = replacement;
  }

  assertNoOverrideContradictions(artifact);

  const hash = hashEffectsContractArtifact(artifact);
  artifact.artifactVersion = `1.0.0+sha256:${hash.slice(0, 16)}`;
  return artifact;
}
