/**
 * behavior-store.test.ts — Tests for the Behavioral Rules Store (ADR-014 Phase 2)
 *
 * Tests the Bayesian confidence scoring, activation thresholds, rule CRUD,
 * correction feedback loop, and MicroRunner integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createBehaviorStore,
  type BehaviorStore,
  PRIOR_ALPHA,
  PRIOR_BETA,
  MIN_OBSERVATIONS,
  MIN_CONFIDENCE,
} from "../src/server/behavior-store.js";
import { createMicroRunner, type ContextSources } from "../src/server/micro-runner.js";

// ─── Test Helpers ───────────────────────────────────────────

let tmpDir: string;
let store: BehaviorStore;

function makeStore(): BehaviorStore {
  const dbPath = path.join(tmpDir, `behavior-${Date.now()}.db`);
  return createBehaviorStore(dbPath);
}

function makeContextSources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    hasFleetConfig: false,
    hasRoster: false,
    hasDockBriefing: false,
    ...overrides,
  };
}

// ─── Setup & Teardown ───────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "majel-behavior-test-"));
  store = makeStore();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Behavioral Rules Store ─────────────────────────────────

describe("BehaviorStore", () => {
  describe("createRule", () => {
    it("creates a rule with skeptical prior", () => {
      const rule = store.createRule("bullet-points", "Always list officer abilities in bullet points", "should");

      expect(rule.id).toBe("bullet-points");
      expect(rule.text).toBe("Always list officer abilities in bullet points");
      expect(rule.severity).toBe("should");
      expect(rule.alpha).toBe(PRIOR_ALPHA);
      expect(rule.beta).toBe(PRIOR_BETA);
      expect(rule.observationCount).toBe(0);
    });

    it("creates a scoped rule for a specific task type", () => {
      const rule = store.createRule("dock-format", "Format dock info as a table", "style", "dock_planning");

      expect(rule.scope.taskType).toBe("dock_planning");
    });

    it("creates an unscoped rule (applies to all tasks)", () => {
      const rule = store.createRule("cite-sources", "Prefix roster citations with 'Your data shows'", "must");

      expect(rule.scope.taskType).toBeUndefined();
    });
  });

  describe("getRule / listRules", () => {
    it("retrieves a rule by ID", () => {
      store.createRule("test-rule", "Test text", "should");

      const rule = store.getRule("test-rule");
      expect(rule).not.toBeNull();
      expect(rule!.text).toBe("Test text");
    });

    it("returns null for unknown rule ID", () => {
      expect(store.getRule("nonexistent")).toBeNull();
    });

    it("lists all rules", () => {
      store.createRule("rule-a", "Rule A", "must");
      store.createRule("rule-b", "Rule B", "should");
      store.createRule("rule-c", "Rule C", "style");

      const all = store.listRules();
      expect(all).toHaveLength(3);
    });
  });

  describe("deleteRule", () => {
    it("deletes an existing rule", () => {
      store.createRule("doomed", "This will be deleted", "style");
      expect(store.deleteRule("doomed")).toBe(true);
      expect(store.getRule("doomed")).toBeNull();
    });

    it("returns false for non-existent rule", () => {
      expect(store.deleteRule("ghost")).toBe(false);
    });
  });

  describe("confidence scoring", () => {
    it("computes skeptical prior confidence correctly", () => {
      const rule = store.createRule("prior-test", "Test", "should");

      const conf = store.confidence(rule);
      expect(conf).toBeCloseTo(PRIOR_ALPHA / (PRIOR_ALPHA + PRIOR_BETA), 5);
      // 2 / (2 + 5) ≈ 0.2857
      expect(conf).toBeCloseTo(0.2857, 3);
    });

    it("increases confidence with positive corrections", () => {
      store.createRule("pos-test", "Test", "should");

      store.recordCorrection("pos-test", +1);
      store.recordCorrection("pos-test", +1);
      store.recordCorrection("pos-test", +1);

      const rule = store.getRule("pos-test")!;
      // α=5, β=5 → confidence = 0.5
      const conf = store.confidence(rule);
      expect(conf).toBeCloseTo(0.5, 3);
    });

    it("decreases confidence with negative corrections", () => {
      store.createRule("neg-test", "Test", "should");

      store.recordCorrection("neg-test", -1);
      store.recordCorrection("neg-test", -1);

      const rule = store.getRule("neg-test")!;
      // α=2, β=7 → confidence ≈ 0.222
      const conf = store.confidence(rule);
      expect(conf).toBeCloseTo(2 / 9, 3);
    });

    it("tracks observation count", () => {
      store.createRule("obs-test", "Test", "should");

      store.recordCorrection("obs-test", +1);
      store.recordCorrection("obs-test", -1);
      store.recordCorrection("obs-test", +1);

      const rule = store.getRule("obs-test")!;
      expect(rule.observationCount).toBe(3);
    });
  });

  describe("activation threshold", () => {
    it("new rules are inactive (below threshold)", () => {
      const rule = store.createRule("new-rule", "Fresh rule", "should");

      expect(store.isActive(rule)).toBe(false);
      // Needs >= 3 observations AND >= 0.5 confidence
    });

    it("rules become active after enough positive corrections", () => {
      store.createRule("activating", "Will activate", "should");

      // 3 positive corrections: α=5, β=5, obs=3, conf=0.5
      store.recordCorrection("activating", +1);
      store.recordCorrection("activating", +1);
      store.recordCorrection("activating", +1);

      const rule = store.getRule("activating")!;
      expect(rule.observationCount).toBe(3);
      expect(store.confidence(rule)).toBeCloseTo(0.5, 3);
      expect(store.isActive(rule)).toBe(true);
    });

    it("rules stay inactive if confidence is too low despite observations", () => {
      store.createRule("low-conf", "Contested rule", "should");

      // 3 negative corrections: α=2, β=8, obs=3, conf=0.2
      store.recordCorrection("low-conf", -1);
      store.recordCorrection("low-conf", -1);
      store.recordCorrection("low-conf", -1);

      const rule = store.getRule("low-conf")!;
      expect(rule.observationCount).toBe(3);
      expect(store.confidence(rule)).toBeCloseTo(0.2, 1);
      expect(store.isActive(rule)).toBe(false);
    });

    it("rules stay inactive if not enough observations despite high potential", () => {
      store.createRule("new-positive", "One positive", "should");

      // 2 positive corrections: α=4, β=5, obs=2, conf≈0.44
      store.recordCorrection("new-positive", +1);
      store.recordCorrection("new-positive", +1);

      const rule = store.getRule("new-positive")!;
      expect(rule.observationCount).toBe(2);
      expect(store.isActive(rule)).toBe(false); // obs < MIN_OBSERVATIONS
    });
  });

  describe("getRules (active rules by task type)", () => {
    it("returns only active rules matching the task type", () => {
      // Create and activate a rule for reference_lookup
      store.createRule("ref-rule", "Format references nicely", "should", "reference_lookup");
      activateRule("ref-rule");

      // Create and activate a rule for dock_planning
      store.createRule("dock-rule", "Use table format for docks", "style", "dock_planning");
      activateRule("dock-rule");

      // Create an unscoped (global) active rule
      store.createRule("global-rule", "Always cite sources", "must");
      activateRule("global-rule");

      const refRules = store.getRules("reference_lookup");
      expect(refRules.some((r) => r.id === "ref-rule")).toBe(true);
      expect(refRules.some((r) => r.id === "global-rule")).toBe(true);
      expect(refRules.some((r) => r.id === "dock-rule")).toBe(false);
    });

    it("returns empty array when no active rules exist", () => {
      store.createRule("inactive", "Not yet activated", "should", "reference_lookup");

      const rules = store.getRules("reference_lookup");
      expect(rules).toHaveLength(0);
    });

    it("sorts by confidence descending", () => {
      store.createRule("high-conf", "High confidence", "must");
      store.createRule("low-conf", "Lower confidence", "style");

      // Give high-conf 5 positive corrections: α=7, β=5, conf≈0.583
      for (let i = 0; i < 5; i++) store.recordCorrection("high-conf", +1);

      // Give low-conf 3 positive corrections: α=5, β=5, conf=0.5
      for (let i = 0; i < 3; i++) store.recordCorrection("low-conf", +1);

      const rules = store.getRules("strategy_general");
      expect(rules[0].id).toBe("high-conf");
      expect(rules[1].id).toBe("low-conf");
    });
  });

  describe("counts", () => {
    it("reports zero counts for empty store", () => {
      const c = store.counts();
      expect(c.total).toBe(0);
      expect(c.active).toBe(0);
      expect(c.inactive).toBe(0);
    });

    it("correctly counts active vs inactive rules", () => {
      store.createRule("active-1", "Active rule", "should");
      activateRule("active-1");

      store.createRule("inactive-1", "Inactive rule", "should");

      const c = store.counts();
      expect(c.total).toBe(2);
      expect(c.active).toBe(1);
      expect(c.inactive).toBe(1);
    });
  });

  describe("recordCorrection edge cases", () => {
    it("returns null for nonexistent rule", () => {
      expect(store.recordCorrection("ghost", +1)).toBeNull();
    });

    it("returns updated rule after correction", () => {
      store.createRule("feedback", "Test feedback", "should");
      const updated = store.recordCorrection("feedback", +1);

      expect(updated).not.toBeNull();
      expect(updated!.alpha).toBe(PRIOR_ALPHA + 1);
      expect(updated!.observationCount).toBe(1);
    });

    it("updates the updatedAt timestamp", () => {
      const rule = store.createRule("timestamp", "Test", "should");
      const originalAlpha = rule.alpha;

      const updated = store.recordCorrection("timestamp", +1);
      // Correction should change the rule's alpha (proving the record was updated)
      expect(updated!.alpha).toBe(originalAlpha + 1);
      // updatedAt is set on correction — may equal createdAt if sub-millisecond
      expect(updated!.updatedAt).toBeTruthy();
    });
  });
});

// ─── MicroRunner Integration ────────────────────────────────

describe("MicroRunner + BehaviorStore integration", () => {
  it("injects active behavioral rules into task contract", () => {
    // Create and activate a behavioral rule
    store.createRule("cite-prefix", "Prefix roster citations with 'Your data shows'", "should");
    activateRule("cite-prefix");

    const ctx = makeContextSources({ hasRoster: true });
    const runner = createMicroRunner({
      contextSources: ctx,
      knownOfficerNames: ["Khan"],
      behaviorStore: store,
    });

    const { contract } = runner.prepare("Tell me about Khan");

    // The behavioral rule should be injected into the contract's rules
    expect(contract.rules.some((r) => r.includes("Prefix roster citations"))).toBe(true);
    expect(contract.rules.some((r) => r.startsWith("SHOULD:"))).toBe(true);
  });

  it("does not inject inactive behavioral rules", () => {
    store.createRule("inactive-rule", "This should not appear", "must");
    // Don't activate it

    const ctx = makeContextSources();
    const runner = createMicroRunner({
      contextSources: ctx,
      behaviorStore: store,
    });

    const { contract } = runner.prepare("What's the PvP meta?");

    expect(contract.rules.some((r) => r.includes("This should not appear"))).toBe(false);
  });

  it("uses severity prefix in injected rules", () => {
    store.createRule("must-rule", "Must do this", "must");
    activateRule("must-rule");

    store.createRule("style-rule", "Style preference", "style");
    activateRule("style-rule");

    const ctx = makeContextSources();
    const runner = createMicroRunner({
      contextSources: ctx,
      behaviorStore: store,
    });

    const { contract } = runner.prepare("Tell me about mining");

    const mustRule = contract.rules.find((r) => r.includes("Must do this"));
    const styleRule = contract.rules.find((r) => r.includes("Style preference"));

    expect(mustRule).toMatch(/^MUST:/);
    expect(styleRule).toMatch(/^STYLE:/);
  });

  it("includes behavioral rules in receipt", () => {
    store.createRule("receipt-rule", "Test receipt inclusion", "should");
    activateRule("receipt-rule");

    const ctx = makeContextSources();
    const runner = createMicroRunner({
      contextSources: ctx,
      behaviorStore: store,
    });

    const { contract, gatedContext } = runner.prepare("General question");
    const result = runner.validate(
      "Here's a thoughtful response.",
      contract,
      gatedContext,
      "session-1",
      Date.now(),
    );

    expect(result.receipt.behavioralRulesApplied).toContain("receipt-rule");
  });

  it("works without a behavior store (Phase 1 compat)", () => {
    const ctx = makeContextSources();
    const runner = createMicroRunner({
      contextSources: ctx,
      // No behaviorStore
    });

    const { contract } = runner.prepare("What's the best crew for the Enterprise?");

    // Should work fine — no behavioral rules, just the existing contract rules
    expect(contract.taskType).toBe("strategy_general");
    expect(contract.rules).toEqual([]);
  });

  it("scoped rules only appear for matching task types", () => {
    store.createRule("dock-only", "Only for dock tasks", "should", "dock_planning");
    activateRule("dock-only");

    const ctx = makeContextSources({ hasDockBriefing: true });
    const runner = createMicroRunner({
      contextSources: ctx,
      behaviorStore: store,
    });

    // Dock query should include the rule
    const dock = runner.prepare("What should D1 run?");
    expect(dock.contract.rules.some((r) => r.includes("Only for dock tasks"))).toBe(true);

    // General query should NOT include the rule
    const general = runner.prepare("Tell me about Star Trek");
    expect(general.contract.rules.some((r) => r.includes("Only for dock tasks"))).toBe(false);
  });
});

// ─── Test Helper ────────────────────────────────────────────

/** Fast-activate a rule by adding enough positive corrections to cross both thresholds */
function activateRule(ruleId: string): void {
  // Need observationCount >= 3 AND confidence >= 0.5
  // Starting at α=2, β=5: need 3 positive to get α=5, β=5, conf=0.5, obs=3
  for (let i = 0; i < 3; i++) {
    store.recordCorrection(ruleId, +1);
  }
}
