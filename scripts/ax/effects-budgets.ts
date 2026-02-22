import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { makeResult } from "./runner.js";
import {
  applyOverridesForBuild,
  deriveInferenceReport,
  readEffectsOverridesFile,
  readEffectsSeedFile,
} from "./effects-harness.js";
import {
  buildEffectsContractV3Artifact,
  hashEffectsContractArtifact,
  summarizeEffectsContractArtifact,
  validateEffectsSeedForV3,
} from "../../src/server/services/effects-contract-v3.js";

interface EffectsBudgetConfig {
  schemaVersion: "1.0.0";
  block: {
    maxInferredPromotedRatio: number;
    minMappedCoveragePercent: number;
  };
  warn: {
    maxLowConfidenceCandidateCount: number;
  };
}

const DEFAULT_BUDGETS: EffectsBudgetConfig = {
  schemaVersion: "1.0.0",
  block: {
    maxInferredPromotedRatio: 0.25,
    minMappedCoveragePercent: 90,
  },
  warn: {
    maxLowConfidenceCandidateCount: 0,
  },
};

async function readBudgetConfig(): Promise<EffectsBudgetConfig> {
  const budgetPath = resolve("data", "seed", "effects-ci-budget.v1.json");
  try {
    const raw = await readFile(budgetPath, "utf-8");
    const parsed = JSON.parse(raw) as EffectsBudgetConfig;
    if (parsed?.schemaVersion !== "1.0.0") return DEFAULT_BUDGETS;
    return parsed;
  } catch {
    return DEFAULT_BUDGETS;
  }
}

const command: AxCommand = {
  name: "effects:budgets",
  description: "Evaluate effects CI block/warn budgets for drift and inference metrics",

  async run(_args): Promise<AxResult> {
    const start = Date.now();
    const snapshotVersion = "stfc-seed-v0";
    const config = await readBudgetConfig();

    const seed = await readEffectsSeedFile();
    const validation = validateEffectsSeedForV3(seed);
    if (!validation.ok) {
      return makeResult("effects:budgets", start, {
        errors: validation.errors,
        warnings: validation.warnings,
      }, {
        success: false,
        errors: ["Seed validation failed (schema drift/unknown refs)"],
      });
    }

    const generatedAt = "2026-02-22T00:00:00.000Z";
    const baseA = buildEffectsContractV3Artifact(seed, {
      snapshotVersion,
      generatorVersion: "0.1.0",
      generatedAt,
    });
    const baseB = buildEffectsContractV3Artifact(seed, {
      snapshotVersion,
      generatorVersion: "0.1.0",
      generatedAt,
    });

    const overrides = await readEffectsOverridesFile();

    let artifactA;
    let artifactB;
    try {
      artifactA = applyOverridesForBuild(baseA, overrides, seed);
      artifactB = applyOverridesForBuild(baseB, overrides, seed);
    } catch (error) {
      return makeResult("effects:budgets", start, {
        overridesPath: "data/seed/effects-overrides.v1.json",
      }, {
        success: false,
        errors: [error instanceof Error ? `Illegal overrides: ${error.message}` : "Illegal overrides"],
      });
    }

    const hashA = hashEffectsContractArtifact(artifactA);
    const hashB = hashEffectsContractArtifact(artifactB);
    const deterministic = hashA === hashB;

    const report = deriveInferenceReport(artifactA, "budget-eval");
    const summary = summarizeEffectsContractArtifact(artifactA);

    let totalAbilities = 0;
    let mappedAbilities = 0;

    let inferredEffects = 0;
    for (const officer of artifactA.officers) {
      for (const ability of officer.abilities) {
        totalAbilities += 1;
        if (ability.isInert || ability.effects.length > 0) {
          mappedAbilities += 1;
        }

        for (const effect of ability.effects) {
          if (effect.inferred) inferredEffects += 1;
        }
      }
    }

    const totalEffects = summary.effects;
    const inferredPromotedRatio = totalEffects > 0 ? inferredEffects / totalEffects : 0;
    const lowConfidenceCandidateCount = report.candidates.filter((candidate) => candidate.confidence.tier === "low").length;

    const mappedCoveragePercent = totalAbilities > 0
      ? (mappedAbilities / totalAbilities) * 100
      : 100;

    const blockErrors: string[] = [];
    const warnings: string[] = [];

    if (!deterministic) {
      blockErrors.push("Non-deterministic output hash for identical inputs");
    }

    if (inferredPromotedRatio > config.block.maxInferredPromotedRatio) {
      blockErrors.push(
        `inferred_promoted_ratio ${inferredPromotedRatio.toFixed(4)} exceeds ${config.block.maxInferredPromotedRatio.toFixed(4)}`,
      );
    }

    if (mappedCoveragePercent < config.block.minMappedCoveragePercent) {
      blockErrors.push(
        `mapped coverage ${mappedCoveragePercent.toFixed(2)}% below ${config.block.minMappedCoveragePercent.toFixed(2)}%`,
      );
    }

    if (lowConfidenceCandidateCount > config.warn.maxLowConfidenceCandidateCount) {
      warnings.push(
        `low_confidence_candidate_count ${lowConfidenceCandidateCount} exceeds ${config.warn.maxLowConfidenceCandidateCount}`,
      );
    }

    const success = blockErrors.length === 0;
    return makeResult("effects:budgets", start, {
      deterministic,
      hashA,
      hashB,
      inferredPromotedRatio,
      lowConfidenceCandidateCount,
      mappedCoveragePercent,
      summary,
      config,
      warnings,
    }, {
      success,
      errors: blockErrors.length > 0 ? blockErrors : undefined,
      hints: warnings.length > 0 ? warnings : undefined,
    });
  },
};

export default command;
