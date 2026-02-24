import { describe, expect, it } from "vitest";
import { evaluateActivationGates, type ActivationMetrics } from "../scripts/ax/effects-gate-evaluator.js";

function baselineMetrics(): ActivationMetrics {
  return {
    officerCount: 278,
    abilityCount: 632,
    mappedAbilitiesCount: 420,
    mappedAbilitiesPercent: 66.45,
    unmappedEntries: 212,
    inferredPromotedRatio: 0.1,
  };
}

describe("effects-gate-evaluator", () => {
  it("skips inferred-ratio caps for deterministic dataset kind", async () => {
    const result = await evaluateActivationGates({
      datasetKind: "deterministic",
      profile: "local_dev",
      metrics: {
        ...baselineMetrics(),
        inferredPromotedRatio: 0.95,
      },
      baselineMetrics: {
        ...baselineMetrics(),
        inferredPromotedRatio: 0.2,
      },
    });

    expect(result.ok).toBe(true);
    const capCheck = result.checks.find((check) => check.name === "caps.maxInferredPromotedRatio");
    expect(capCheck?.passed).toBe(true);
    expect(capCheck?.detail).toContain("skipped for datasetKind=deterministic");
  });

  it("enforces inferred-ratio caps for hybrid dataset kind", async () => {
    const result = await evaluateActivationGates({
      datasetKind: "hybrid",
      profile: "cloud_activation",
      metrics: {
        ...baselineMetrics(),
        inferredPromotedRatio: 0.8,
      },
      baselineMetrics: baselineMetrics(),
    });

    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.startsWith("caps.maxInferredPromotedRatio"))).toBe(true);
  });

  it("enforces baseline non-regression thresholds", async () => {
    const result = await evaluateActivationGates({
      datasetKind: "hybrid",
      profile: "cloud_activation",
      metrics: {
        ...baselineMetrics(),
        mappedAbilitiesPercent: 40,
      },
      baselineMetrics: baselineMetrics(),
    });

    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.startsWith("nonRegression.mappedPercentDrop"))).toBe(true);
  });

  it("fails for unknown profile", async () => {
    const result = await evaluateActivationGates({
      datasetKind: "hybrid",
      profile: "does-not-exist",
      metrics: baselineMetrics(),
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("unknown profile");
  });

  it("skips non-regression checks when baseline metrics are malformed", async () => {
    const result = await evaluateActivationGates({
      datasetKind: "hybrid",
      profile: "cloud_activation",
      metrics: baselineMetrics(),
      baselineMetrics: {
        ...baselineMetrics(),
        unmappedEntries: Number.NaN,
      },
    });

    expect(result.ok).toBe(true);
    const baselineCheck = result.checks.find((check) => check.name === "nonRegression.baselineMetrics");
    expect(baselineCheck?.passed).toBe(true);
    expect(baselineCheck?.detail).toContain("skipped");
  });
});
