import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ROOT } from "./runner.js";

export interface ActivationMetrics {
  officerCount: number;
  abilityCount: number;
  mappedAbilitiesCount: number;
  mappedAbilitiesPercent: number;
  unmappedEntries: number;
  inferredPromotedRatio: number;
}

interface GateProfile {
  allowedDatasetKinds: string[];
  minimumViability: {
    mappedThresholdMode: "OR" | "AND";
    minMappedAbilitiesPercent: number;
    minMappedAbilitiesCount: number;
    minOfficerCount: number;
    minAbilityCount: number;
  };
  nonRegression: {
    maxMappedPercentDropPoints: number;
    maxUnmappedCountIncrease: number;
    maxOfficerCountDrop: number;
    maxAbilityCountDrop: number;
    maxInferredPromotedRatioIncreasePoints: number;
  };
  caps: {
    maxInferredPromotedRatio: number;
  };
}

interface GatePolicy {
  schemaVersion: string;
  defaultProfile: string;
  profiles: Record<string, GateProfile>;
}

export interface GateEvaluationInput {
  datasetKind: string;
  profile?: string;
  metrics: ActivationMetrics;
  baselineMetrics?: ActivationMetrics | null;
}

export interface GateEvaluationResult {
  ok: boolean;
  profile: string;
  violations: string[];
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasValidBaselineMetrics(baseline: ActivationMetrics | null | undefined): baseline is ActivationMetrics {
  if (!baseline) return false;
  return isFiniteNumber(baseline.officerCount)
    && isFiniteNumber(baseline.abilityCount)
    && isFiniteNumber(baseline.mappedAbilitiesCount)
    && isFiniteNumber(baseline.mappedAbilitiesPercent)
    && isFiniteNumber(baseline.unmappedEntries)
    && isFiniteNumber(baseline.inferredPromotedRatio);
}

export async function loadGatePolicy(): Promise<GatePolicy> {
  const path = resolve(ROOT, "data", "seed", "effects-activation-gates.v1.json");
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as GatePolicy;
}

export async function evaluateActivationGates(input: GateEvaluationInput): Promise<GateEvaluationResult> {
  const policy = await loadGatePolicy();
  const profileName = input.profile ?? policy.defaultProfile;
  const profile = policy.profiles[profileName];
  if (!profile) {
    return {
      ok: false,
      profile: profileName,
      violations: [`unknown profile '${profileName}'`],
      checks: [],
    };
  }

  const checks: GateEvaluationResult["checks"] = [];
  const violations: string[] = [];

  const addCheck = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
    if (!passed) violations.push(`${name}: ${detail}`);
  };

  addCheck(
    "allowedDatasetKind",
    profile.allowedDatasetKinds.includes(input.datasetKind),
    `datasetKind=${input.datasetKind}, allowed=${profile.allowedDatasetKinds.join(",")}`,
  );

  const viability = profile.minimumViability;
  const mappedPercentPass = input.metrics.mappedAbilitiesPercent >= viability.minMappedAbilitiesPercent;
  const mappedCountPass = input.metrics.mappedAbilitiesCount >= viability.minMappedAbilitiesCount;
  const mappedThresholdPass = viability.mappedThresholdMode === "OR"
    ? (mappedPercentPass || mappedCountPass)
    : (mappedPercentPass && mappedCountPass);

  addCheck(
    "minimumViability.mappedThreshold",
    mappedThresholdPass,
    `percent=${input.metrics.mappedAbilitiesPercent.toFixed(2)} (min ${viability.minMappedAbilitiesPercent}), count=${input.metrics.mappedAbilitiesCount} (min ${viability.minMappedAbilitiesCount}), mode=${viability.mappedThresholdMode}`,
  );
  addCheck(
    "minimumViability.officerCount",
    input.metrics.officerCount >= viability.minOfficerCount,
    `officerCount=${input.metrics.officerCount}, min=${viability.minOfficerCount}`,
  );
  addCheck(
    "minimumViability.abilityCount",
    input.metrics.abilityCount >= viability.minAbilityCount,
    `abilityCount=${input.metrics.abilityCount}, min=${viability.minAbilityCount}`,
  );

  const appliesInferredRatioChecks = input.datasetKind === "hybrid";
  if (appliesInferredRatioChecks) {
    addCheck(
      "caps.maxInferredPromotedRatio",
      input.metrics.inferredPromotedRatio <= profile.caps.maxInferredPromotedRatio,
      `ratio=${input.metrics.inferredPromotedRatio.toFixed(4)}, max=${profile.caps.maxInferredPromotedRatio}`,
    );
  } else {
    addCheck(
      "caps.maxInferredPromotedRatio",
      true,
      `skipped for datasetKind=${input.datasetKind}`,
    );
  }

  const baseline = input.baselineMetrics;
  if (baseline && !hasValidBaselineMetrics(baseline)) {
    addCheck(
      "nonRegression.baselineMetrics",
      true,
      "skipped: baseline metrics malformed or non-finite",
    );
  } else if (baseline) {
    const nonRegression = profile.nonRegression;
    const mappedDrop = baseline.mappedAbilitiesPercent - input.metrics.mappedAbilitiesPercent;
    const unmappedIncrease = input.metrics.unmappedEntries - baseline.unmappedEntries;
    const officerDrop = baseline.officerCount - input.metrics.officerCount;
    const abilityDrop = baseline.abilityCount - input.metrics.abilityCount;
    const inferredRatioIncrease = input.metrics.inferredPromotedRatio - baseline.inferredPromotedRatio;

    addCheck(
      "nonRegression.mappedPercentDrop",
      mappedDrop <= nonRegression.maxMappedPercentDropPoints,
      `drop=${mappedDrop.toFixed(2)}, max=${nonRegression.maxMappedPercentDropPoints}`,
    );
    addCheck(
      "nonRegression.unmappedIncrease",
      unmappedIncrease <= nonRegression.maxUnmappedCountIncrease,
      `increase=${unmappedIncrease}, max=${nonRegression.maxUnmappedCountIncrease}`,
    );
    addCheck(
      "nonRegression.officerCountDrop",
      officerDrop <= nonRegression.maxOfficerCountDrop,
      `drop=${officerDrop}, max=${nonRegression.maxOfficerCountDrop}`,
    );
    addCheck(
      "nonRegression.abilityCountDrop",
      abilityDrop <= nonRegression.maxAbilityCountDrop,
      `drop=${abilityDrop}, max=${nonRegression.maxAbilityCountDrop}`,
    );
    if (appliesInferredRatioChecks) {
      addCheck(
        "nonRegression.inferredPromotedRatioIncrease",
        inferredRatioIncrease <= nonRegression.maxInferredPromotedRatioIncreasePoints,
        `increase=${inferredRatioIncrease.toFixed(4)}, max=${nonRegression.maxInferredPromotedRatioIncreasePoints}`,
      );
    } else {
      addCheck(
        "nonRegression.inferredPromotedRatioIncrease",
        true,
        `skipped for datasetKind=${input.datasetKind}`,
      );
    }
  }

  return {
    ok: violations.length === 0,
    profile: profileName,
    violations,
    checks,
  };
}
