/**
 * governance.test.ts — Unit Tests for Runtime Governance Module
 *
 * Tests the governance layer in isolation (no DB required):
 *   - Constraint derivation (pure function)
 *   - Specificity scoring
 *   - Trust-gap calibration
 *   - MicroRunner governance integration
 */

import { describe, it, expect } from "vitest";
import { deriveConstraints } from "../src/server/services/governance/derive.js";
import {
  type GovernanceRule,
  type AgentTrustProfile,
  type TrustGapEvent,
  SPECIFICITY_WEIGHTS,
  PRIOR_ALPHA,
  PRIOR_BETA,
  MIN_OBSERVATIONS,
  MIN_CONFIDENCE,
  GAP_RATE_THRESHOLD,
  MAX_CONFIDENCE_REDUCTION,
  PATTERN_LEARNING_THRESHOLD,
  confidence,
  isActive,
} from "../src/server/services/governance/types.js";
import type { ScoredGovernanceRule } from "../src/server/services/governance/rule-store.js";
import type { GovernanceContext, TaskType } from "../src/server/services/micro-runner.js";

// ─── Helpers ────────────────────────────────────────────────

function makeGovernance(overrides?: Partial<GovernanceContext>): GovernanceContext {
  return {
    userId: "local",
    role: "admiral",
    tenantId: "local",
    modelFamily: "gemini-2.5-flash",
    procedureMode: "chat",
    ...overrides,
  };
}

function makeRule(overrides?: Partial<GovernanceRule & { specificity: number }>): ScoredGovernanceRule {
  const base: GovernanceRule = {
    id: "rule-1",
    text: "Require source attribution for numeric claims",
    scope: {
      taskType: null,
      modelFamily: null,
      userId: null,
      procedureMode: null,
    },
    category: "grounding",
    severity: "should",
    source: "manual",
    alpha: 10,
    beta: 2,
    observationCount: 12,
    createdAt: "2026-04-10T00:00:00Z",
    updatedAt: "2026-04-10T00:00:00Z",
    ...overrides,
  };
  return { ...base, specificity: overrides?.specificity ?? 0 };
}

function makeTrustProfile(overrides?: Partial<AgentTrustProfile>): AgentTrustProfile {
  return {
    modelFamily: "gemini-2.5-flash",
    taskType: "reference_lookup",
    totalRequests: 100,
    trustGaps: 5,
    gapRate: 0.05,
    commonViolations: [],
    firstSeen: "2026-04-01T00:00:00Z",
    lastSeen: "2026-04-10T00:00:00Z",
    ...overrides,
  };
}

// ─── Types ──────────────────────────────────────────────────

describe("GovernanceRule confidence & activation", () => {
  it("computes confidence as α / (α + β)", () => {
    const rule = makeRule({ alpha: 8, beta: 2 });
    expect(confidence(rule)).toBeCloseTo(0.8);
  });

  it("skeptical prior is below activation threshold", () => {
    const rule = makeRule({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA, observationCount: 0 });
    expect(confidence(rule)).toBeCloseTo(PRIOR_ALPHA / (PRIOR_ALPHA + PRIOR_BETA));
    expect(isActive(rule)).toBe(false);
  });

  it("activates when observations and confidence meet thresholds", () => {
    const rule = makeRule({ alpha: 10, beta: 2, observationCount: 12 });
    expect(isActive(rule)).toBe(true);
  });

  it("inactive when insufficient observations", () => {
    const rule = makeRule({ alpha: 10, beta: 2, observationCount: 2 });
    expect(isActive(rule)).toBe(false);
  });

  it("inactive when confidence too low", () => {
    const rule = makeRule({ alpha: 2, beta: 10, observationCount: 12 });
    expect(isActive(rule)).toBe(false);
  });
});

// ─── Derivation ─────────────────────────────────────────────

describe("deriveConstraints", () => {
  const gov = makeGovernance();

  it("returns empty constraints when no rules provided", () => {
    const result = deriveConstraints([], gov, "strategy_general");
    expect(result.constraints).toHaveLength(0);
    expect(result.metadata.rulesConsidered).toBe(0);
    expect(result.metadata.rulesFiltered).toBe(0);
  });

  it("filters out inactive rules", () => {
    const inactive = makeRule({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA, observationCount: 1 });
    const result = deriveConstraints([inactive], gov, "strategy_general");
    expect(result.constraints).toHaveLength(0);
    expect(result.metadata.rulesFiltered).toBe(1);
  });

  it("includes active rules", () => {
    const active = makeRule({ alpha: 10, beta: 2, observationCount: 12 });
    const result = deriveConstraints([active], gov, "reference_lookup");
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints[0].ruleId).toBe("rule-1");
    expect(result.constraints[0].effectiveConfidence).toBeCloseTo(0.833, 2);
  });

  it("sorts by specificity descending", () => {
    const broad = makeRule({ id: "broad", specificity: 0, alpha: 10, beta: 2, observationCount: 12 });
    const narrow = makeRule({ id: "narrow", specificity: 7, alpha: 10, beta: 2, observationCount: 12, text: "Narrow rule" });
    const result = deriveConstraints([broad, narrow], gov, "reference_lookup");
    expect(result.constraints[0].ruleId).toBe("narrow");
    expect(result.constraints[1].ruleId).toBe("broad");
  });

  it("sorts by severity within same specificity", () => {
    const shouldRule = makeRule({ id: "should1", severity: "should", alpha: 10, beta: 2, observationCount: 12 });
    const mustRule = makeRule({ id: "must1", severity: "must", alpha: 10, beta: 2, observationCount: 12, text: "Must rule" });
    const result = deriveConstraints([shouldRule, mustRule], gov, "strategy_general");
    expect(result.constraints[0].severity).toBe("must");
    expect(result.constraints[1].severity).toBe("should");
  });

  it("produces deterministic inputHash", () => {
    const rule = makeRule();
    const r1 = deriveConstraints([rule], gov, "reference_lookup");
    const r2 = deriveConstraints([rule], gov, "reference_lookup");
    expect(r1.inputHash).toBe(r2.inputHash);
    expect(r1.inputHash).toHaveLength(16);
  });

  it("inputHash changes with different context", () => {
    const rule = makeRule();
    const r1 = deriveConstraints([rule], gov, "reference_lookup");
    const r2 = deriveConstraints([rule], gov, "strategy_general");
    expect(r1.inputHash).not.toBe(r2.inputHash);
  });

  describe("trust calibration", () => {
    it("does not adjust when gap rate is below threshold", () => {
      const rule = makeRule({ alpha: 10, beta: 2, observationCount: 12 });
      const profile = makeTrustProfile({ gapRate: 0.1 });
      const result = deriveConstraints([rule], gov, "reference_lookup", profile);
      expect(result.metadata.trustAdjustment).toBe(1.0);
      expect(result.constraints[0].effectiveConfidence).toBeCloseTo(0.833, 2);
    });

    it("reduces confidence when gap rate exceeds threshold", () => {
      const rule = makeRule({ alpha: 10, beta: 2, observationCount: 12 });
      const profile = makeTrustProfile({ gapRate: 0.25 });
      const result = deriveConstraints([rule], gov, "reference_lookup", profile);
      expect(result.metadata.trustAdjustment).toBeLessThan(1.0);
      // Effective confidence should be reduced
      const baseConfidence = 10 / 12;
      expect(result.constraints[0].effectiveConfidence).toBeLessThan(baseConfidence);
    });

    it("caps confidence reduction at MAX_CONFIDENCE_REDUCTION", () => {
      const rule = makeRule({ alpha: 10, beta: 2, observationCount: 12 });
      const profile = makeTrustProfile({ gapRate: 0.9 });
      const result = deriveConstraints([rule], gov, "reference_lookup", profile);
      expect(result.metadata.trustAdjustment).toBeCloseTo(1.0 - MAX_CONFIDENCE_REDUCTION);
    });
  });
});

// ─── Specificity Weights ────────────────────────────────────

describe("SPECIFICITY_WEIGHTS", () => {
  it("task type is highest weight", () => {
    expect(SPECIFICITY_WEIGHTS.taskType).toBeGreaterThanOrEqual(SPECIFICITY_WEIGHTS.modelFamily);
    expect(SPECIFICITY_WEIGHTS.taskType).toBeGreaterThanOrEqual(SPECIFICITY_WEIGHTS.userId);
    expect(SPECIFICITY_WEIGHTS.taskType).toBeGreaterThanOrEqual(SPECIFICITY_WEIGHTS.procedureMode);
  });
});

// ─── Trust Gap Types ────────────────────────────────────────

describe("TrustGapEvent", () => {
  it("can be constructed with required fields", () => {
    const event: TrustGapEvent = {
      modelFamily: "gemini-2.5-flash",
      taskType: "reference_lookup",
      ruleCategory: "no fabricated system diagnostics",
      violation: "System diagnostic claims detected",
      caughtBy: "shadow",
      sessionId: "test-session",
      timestamp: new Date().toISOString(),
    };
    expect(event.caughtBy).toBe("shadow");
  });
});

describe("Thresholds", () => {
  it("PATTERN_LEARNING_THRESHOLD is 3", () => {
    expect(PATTERN_LEARNING_THRESHOLD).toBe(3);
  });

  it("GAP_RATE_THRESHOLD is 0.2", () => {
    expect(GAP_RATE_THRESHOLD).toBe(0.2);
  });
});

// ─── MicroRunner receipt integration ────────────────────────

describe("MicroRunner governance receipt fields", () => {
  it("receipt includes derivedConstraints and trustGapEvents", async () => {
    // Import dynamically to use the real createMicroRunner
    const { createMicroRunner } = await import("../src/server/services/micro-runner.js");

    const runner = createMicroRunner({
      contextSources: {
        hasFleetConfig: false,
        hasRoster: false,
        hasDockBriefing: false,
      },
    });

    const governance: GovernanceContext = {
      userId: "test",
      role: "admiral",
      tenantId: "test",
      modelFamily: "gemini-2.5-flash",
      procedureMode: "chat",
    };

    const { contract, gatedContext } = await runner.prepare("hello", governance);

    const { receipt } = await runner.validate(
      "Here is a general response about strategy.",
      contract,
      gatedContext,
      "session-1",
      Date.now(),
      "hello",
      governance,
    );

    // New fields should be present
    expect(receipt).toHaveProperty("derivedConstraints");
    expect(receipt).toHaveProperty("trustGapEvents");
    // Without governance stores, both should be null/empty
    expect(receipt.derivedConstraints).toBeNull();
    expect(receipt.trustGapEvents).toEqual([]);
  });

  it("emits trust-gap events when validation fails", async () => {
    const { createMicroRunner } = await import("../src/server/services/micro-runner.js");

    const runner = createMicroRunner({
      contextSources: {
        hasFleetConfig: false,
        hasRoster: false,
        hasDockBriefing: false,
      },
    });

    const governance: GovernanceContext = {
      userId: "test",
      role: "admiral",
      tenantId: "test",
      modelFamily: "gemini-2.5-flash",
      procedureMode: "chat",
    };

    const { contract, gatedContext } = await runner.prepare("tell me about Khan", governance);

    // Fabricate a response with system diagnostics to trigger violation
    const violation = "The memory frames count is 42 and connection status is 1";
    const { receipt } = await runner.validate(
      violation,
      contract,
      gatedContext,
      "session-2",
      Date.now(),
      "tell me about Khan",
      governance,
    );

    // Should have trust-gap events for the failing invariant
    expect(receipt.trustGapEvents.length).toBeGreaterThan(0);
    expect(receipt.trustGapEvents[0].modelFamily).toBe("gemini-2.5-flash");
    expect(receipt.trustGapEvents[0].caughtBy).toBe("runtime");
  });
});
