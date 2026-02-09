/**
 * micro-runner.test.ts — Tests for the MicroRunner pipeline.
 *
 * Tests PromptCompiler, ContextGate, OutputValidator, and the
 * MicroRunner orchestrator independently and together.
 *
 * See ADR-014 for architecture rationale.
 */

import { describe, it, expect } from "vitest";
import {
  compileTask,
  gateContext,
  buildAugmentedMessage,
  validateResponse,
  buildRepairPrompt,
  createMicroRunner,
  VALIDATION_DISCLAIMER,
  type ContextSources,
  type TaskContract,
  type GatedContext,
  type ReferenceEntry,
} from "../src/server/micro-runner.js";

// ─── Test Helpers ───────────────────────────────────────────

function makeContextSources(overrides?: Partial<ContextSources>): ContextSources {
  return {
    hasFleetConfig: false,
    hasRoster: false,
    hasDockBriefing: false,
    ...overrides,
  };
}

function makeOfficerLookup(officers: ReferenceEntry[]): (name: string) => ReferenceEntry | null {
  return (name: string) => {
    const lower = name.toLowerCase();
    return officers.find((o) => o.name.toLowerCase() === lower) ?? null;
  };
}

const KHAN: ReferenceEntry = {
  id: "khan",
  name: "Khan",
  rarity: "epic",
  groupName: "augments",
  source: "STFC wiki",
  importedAt: "2026-02-09T10:00:00Z",
};

const KIRK: ReferenceEntry = {
  id: "kirk",
  name: "Kirk",
  rarity: "epic",
  groupName: "enterprise-crew",
  source: "STFC wiki",
  importedAt: "2026-02-09T10:00:00Z",
};

// ─── PromptCompiler ─────────────────────────────────────────

describe("PromptCompiler (compileTask)", () => {
  describe("task classification", () => {
    it("classifies dock questions as dock_planning", () => {
      const ctx = makeContextSources({ hasDockBriefing: true });
      expect(compileTask("What should dock 2 run for swarms?", ctx).taskType).toBe("dock_planning");
      expect(compileTask("My drydock setup needs work", ctx).taskType).toBe("dock_planning");
      expect(compileTask("Configure D3 for mining", ctx).taskType).toBe("dock_planning");
      expect(compileTask("Update my dry dock loadout", ctx).taskType).toBe("dock_planning");
    });

    it("classifies roster questions as fleet_query", () => {
      const ctx = makeContextSources({ hasRoster: true });
      expect(compileTask("Show me my roster", ctx).taskType).toBe("fleet_query");
      expect(compileTask("What's in my fleet?", ctx).taskType).toBe("fleet_query");
      expect(compileTask("List my officers", ctx).taskType).toBe("fleet_query");
      expect(compileTask("How many ships in my fleet?", ctx).taskType).toBe("fleet_query");
    });

    it("classifies officer name mentions as reference_lookup", () => {
      const ctx = makeContextSources({ hasRoster: true });
      const names = ["Khan", "Kirk", "Spock"];
      expect(compileTask("What does officer Khan do?", ctx, names).taskType).toBe("reference_lookup");
      expect(compileTask("Tell me about Kirk", ctx, names).taskType).toBe("reference_lookup");
    });

    it("falls through to strategy_general for unmatched messages", () => {
      const ctx = makeContextSources();
      expect(compileTask("What's the best PvP strategy?", ctx).taskType).toBe("strategy_general");
      expect(compileTask("Tell me about the Enterprise-D", ctx).taskType).toBe("strategy_general");
      expect(compileTask("How do armadas work?", ctx).taskType).toBe("strategy_general");
    });

    it("prioritizes dock_planning over reference_lookup", () => {
      // "dock" keyword should win even if officer names are present
      const ctx = makeContextSources({ hasDockBriefing: true, hasRoster: true });
      const names = ["Khan"];
      expect(compileTask("Put Khan on dock 2", ctx, names).taskType).toBe("dock_planning");
    });

    it("does not match short officer names (<=2 chars)", () => {
      const ctx = makeContextSources({ hasRoster: true });
      const names = ["Xi", "Khan"];
      // "Xi" is too short, should not match
      expect(compileTask("Tell me about Xi", ctx, names).taskType).toBe("strategy_general");
      // "Khan" should still match
      expect(compileTask("Tell me about Khan", ctx, names).taskType).toBe("reference_lookup");
    });
  });

  describe("contract structure", () => {
    it("reference_lookup requests T1 roster and T2 reference pack", () => {
      const ctx = makeContextSources({ hasRoster: true });
      const contract = compileTask("What does Khan do?", ctx, ["Khan"]);
      expect(contract.requiredTiers.t1_roster).toBe(true);
      expect(contract.requiredTiers.t2_referencePack).toContain("Khan");
      expect(contract.rules).toContain("no numeric claims unless cited from T1/T2");
      expect(contract.outputSchema.factsUsed).toBe(true);
    });

    it("dock_planning requests T1 fleet config, roster, and dock briefing", () => {
      const ctx = makeContextSources({ hasFleetConfig: true, hasRoster: true, hasDockBriefing: true });
      const contract = compileTask("What should dock 3 run?", ctx);
      expect(contract.requiredTiers.t1_fleetConfig).toBe(true);
      expect(contract.requiredTiers.t1_roster).toBe(true);
      expect(contract.requiredTiers.t1_dockBriefing).toBe(true);
      expect(contract.rules).toContain("reference dock data when present");
    });

    it("strategy_general has minimal constraints", () => {
      const ctx = makeContextSources();
      const contract = compileTask("How do armadas work?", ctx);
      expect(contract.rules).toHaveLength(0);
      expect(contract.outputSchema.confidence).toBe(true);
    });

    it("dock_planning marks unavailable tiers as false", () => {
      const ctx = makeContextSources({ hasDockBriefing: false, hasRoster: false });
      const contract = compileTask("What should dock 1 run?", ctx);
      expect(contract.requiredTiers.t1_dockBriefing).toBe(false);
      expect(contract.requiredTiers.t1_roster).toBe(false);
    });
  });

  describe("context manifest", () => {
    it("includes available T1 sources", () => {
      const ctx = makeContextSources({ hasFleetConfig: true, hasRoster: true, hasDockBriefing: true });
      const contract = compileTask("What should dock 1 run?", ctx);
      expect(contract.contextManifest).toContain("T1 fleet-config");
      expect(contract.contextManifest).toContain("T1 roster");
      expect(contract.contextManifest).toContain("T1 docks");
    });

    it("includes T2 reference names", () => {
      const ctx = makeContextSources({ hasRoster: true });
      const contract = compileTask("Tell me about Khan", ctx, ["Khan"]);
      expect(contract.contextManifest).toContain("T2 reference(Khan)");
    });

    it("always includes T3 training", () => {
      const ctx = makeContextSources();
      const contract = compileTask("How do armadas work?", ctx);
      expect(contract.contextManifest).toContain("T3 training");
    });

    it("omits unavailable T1 sources", () => {
      const ctx = makeContextSources({ hasFleetConfig: false });
      const contract = compileTask("What should dock 1 run?", ctx);
      expect(contract.contextManifest).not.toContain("T1 fleet-config");
    });
  });
});

// ─── ContextGate ────────────────────────────────────────────

describe("ContextGate (gateContext)", () => {
  it("returns null contextBlock for strategy_general with no data", () => {
    const ctx = makeContextSources();
    const contract = compileTask("How do armadas work?", ctx);
    const gated = gateContext(contract, ctx);
    expect(gated.contextBlock).toBeNull();
    expect(gated.keysInjected).toHaveLength(0);
  });

  it("injects T2 reference block with provenance when officer found", () => {
    const lookup = makeOfficerLookup([KHAN]);
    const ctx = makeContextSources({ hasRoster: true, lookupOfficer: lookup });
    const contract = compileTask("Tell me about Khan", ctx, ["Khan"]);
    const gated = gateContext(contract, ctx);

    expect(gated.contextBlock).toContain("REFERENCE: Officer \"Khan\"");
    expect(gated.contextBlock).toContain("source: STFC wiki");
    expect(gated.contextBlock).toContain("imported 2026-02-09");
    expect(gated.contextBlock).toContain("Rarity: epic");
    expect(gated.contextBlock).toContain("Group: augments");
    expect(gated.contextBlock).toContain("[CONTEXT FOR THIS QUERY");
    expect(gated.contextBlock).toContain("[END CONTEXT]");
    expect(gated.keysInjected).toContain("t2:officer:khan");
    expect(gated.t2Provenance).toHaveLength(1);
    expect(gated.t2Provenance[0].id).toBe("khan");
  });

  it("injects multiple T2 references when multiple officers mentioned", () => {
    const lookup = makeOfficerLookup([KHAN, KIRK]);
    const ctx = makeContextSources({ hasRoster: true, lookupOfficer: lookup });
    const contract = compileTask("Compare Khan and Kirk", ctx, ["Khan", "Kirk"]);
    const gated = gateContext(contract, ctx);

    expect(gated.contextBlock).toContain("Officer \"Khan\"");
    expect(gated.contextBlock).toContain("Officer \"Kirk\"");
    expect(gated.keysInjected).toHaveLength(2);
    expect(gated.t2Provenance).toHaveLength(2);
  });

  it("skips T2 entries when officer not found in lookup", () => {
    const lookup = makeOfficerLookup([KHAN]);
    const ctx = makeContextSources({ hasRoster: true, lookupOfficer: lookup });
    // Contract asks for "Spock" but lookup only has Khan
    const contract: TaskContract = {
      taskType: "reference_lookup",
      requiredTiers: { t1_fleetConfig: false, t1_roster: true, t1_dockBriefing: false, t2_referencePack: ["Spock"] },
      contextManifest: "Available: T2 reference(Spock), T3 training",
      rules: ["cite source tier for all factual claims"],
      outputSchema: { answer: true, factsUsed: true, assumptions: false, unknowns: true, confidence: false },
    };
    const gated = gateContext(contract, ctx);
    expect(gated.contextBlock).toBeNull();
    expect(gated.keysInjected).toHaveLength(0);
  });

  it("includes AVAILABLE CONTEXT manifest line", () => {
    const lookup = makeOfficerLookup([KHAN]);
    const ctx = makeContextSources({ hasRoster: true, lookupOfficer: lookup });
    const contract = compileTask("Tell me about Khan", ctx, ["Khan"]);
    const gated = gateContext(contract, ctx);

    expect(gated.contextBlock).toContain("AVAILABLE CONTEXT:");
  });
});

// ─── buildAugmentedMessage ──────────────────────────────────

describe("buildAugmentedMessage", () => {
  it("returns original message when no context block", () => {
    const gated: GatedContext = { contextBlock: null, keysInjected: [], t2Provenance: [] };
    expect(buildAugmentedMessage("How do armadas work?", gated)).toBe("How do armadas work?");
  });

  it("prepends context block to user message", () => {
    const gated: GatedContext = {
      contextBlock: "[CONTEXT FOR THIS QUERY]\nREFERENCE: Khan\n[END CONTEXT]",
      keysInjected: ["t2:officer:khan"],
      t2Provenance: [],
    };
    const result = buildAugmentedMessage("Tell me about Khan", gated);
    expect(result).toMatch(/^\[CONTEXT FOR THIS QUERY\]/);
    expect(result).toContain("Tell me about Khan");
    expect(result.indexOf("[END CONTEXT]")).toBeLessThan(result.indexOf("Tell me about Khan"));
  });
});

// ─── OutputValidator ────────────────────────────────────────

describe("OutputValidator (validateResponse)", () => {
  const refLookupContract: TaskContract = {
    taskType: "reference_lookup",
    requiredTiers: { t1_fleetConfig: false, t1_roster: true, t1_dockBriefing: false, t2_referencePack: ["Khan"] },
    contextManifest: "Available: T1 roster, T2 reference(Khan), T3 training",
    rules: ["cite source tier for all factual claims", "no numeric claims unless cited from T1/T2"],
    outputSchema: { answer: true, factsUsed: true, assumptions: false, unknowns: true, confidence: false },
  };

  const strategyContract: TaskContract = {
    taskType: "strategy_general",
    requiredTiers: { t1_fleetConfig: false, t1_roster: false, t1_dockBriefing: false, t2_referencePack: [] },
    contextManifest: "Available: T3 training",
    rules: [],
    outputSchema: { answer: true, factsUsed: false, assumptions: false, unknowns: false, confidence: true },
  };

  const emptyGated: GatedContext = { contextBlock: null, keysInjected: [], t2Provenance: [] };

  describe("strategy_general bypass", () => {
    it("always passes for strategy_general (no validation)", () => {
      const result = validateResponse(
        "The best PvP strategy at level 40 with tier 6 ships is to focus on interceptors.",
        strategyContract,
        emptyGated,
      );
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe("numeric claim detection", () => {
    it("flags ungrounded numeric claims", () => {
      const result = validateResponse(
        "Khan has level 40 with power 1.2M and does +25% damage to all enemies.",
        refLookupContract,
        emptyGated,
      );
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("Numeric claims"))).toBe(true);
    });

    it("passes numeric claims with source attribution", () => {
      const result = validateResponse(
        "Your roster shows Khan at level 40 with 1.2M power. According to your data, he does +25% damage.",
        refLookupContract,
        emptyGated,
      );
      expect(result.passed).toBe(true);
    });

    it("passes numeric claims with uncertainty signals", () => {
      const result = validateResponse(
        "Based on my training data, which may be outdated, Khan typically sits around level 40 at tier 4.",
        refLookupContract,
        emptyGated,
      );
      expect(result.passed).toBe(true);
    });

    it("passes responses with no numeric claims", () => {
      const result = validateResponse(
        "Khan is a strong augment officer who excels in combat scenarios. He pairs well with other augments.",
        refLookupContract,
        emptyGated,
      );
      expect(result.passed).toBe(true);
    });
  });

  describe("system diagnostic detection", () => {
    it("flags fabricated system diagnostics", () => {
      const result = validateResponse(
        "Your system health status: memory frames is 42, connection status is 3 active.",
        refLookupContract,
        emptyGated,
      );
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("System diagnostic"))).toBe(true);
    });

    it("passes normal responses without diagnostic claims", () => {
      const result = validateResponse(
        "I can't inspect my own runtime state. For diagnostics, check /api/health.",
        refLookupContract,
        emptyGated,
      );
      expect(result.passed).toBe(true);
    });
  });

  describe("patch note detection", () => {
    it("flags fabricated patch claims without uncertainty", () => {
      const result = validateResponse(
        "In patch 64 they changed Khan's ability. Updated in version 3.2 which launched last month.",
        refLookupContract,
        emptyGated,
      );
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("Patch/version"))).toBe(true);
    });

    it("passes patch mentions with uncertainty signals", () => {
      const result = validateResponse(
        "I believe they may have changed this in a recent patch, but I'm not certain of the specifics.",
        refLookupContract,
        emptyGated,
      );
      expect(result.passed).toBe(true);
    });
  });

  describe("source attribution check", () => {
    it("flags long factual responses without any source signal", () => {
      // Create a response >200 chars with numerics but no source attribution
      const longResponse = "Khan is an excellent officer. He has level 40 stats with incredible power. " +
        "His captain maneuver increases attack damage significantly. He costs 500K resources to upgrade. " +
        "At tier 6 he becomes one of the strongest officers in the game. His abilities synergize well with other augments.";
      const result = validateResponse(longResponse, refLookupContract, emptyGated);
      expect(result.passed).toBe(false);
    });

    it("passes short responses without source attribution", () => {
      const result = validateResponse(
        "Khan is a strong officer with level 40 power.",
        refLookupContract,
        emptyGated,
      );
      // Short response (<200 chars) with numerics — numeric rule may catch it
      // but the "cite source" rule specifically targets long factual content
      expect(result.violations.filter((v) => v.includes("no source attribution")).length).toBe(0);
    });
  });
});

// ─── buildRepairPrompt ──────────────────────────────────────

describe("buildRepairPrompt", () => {
  it("includes violations and contract rules", () => {
    const contract: TaskContract = {
      taskType: "reference_lookup",
      requiredTiers: { t1_fleetConfig: false, t1_roster: true, t1_dockBriefing: false, t2_referencePack: ["Khan"] },
      contextManifest: "Available: T1 roster, T2 reference(Khan), T3 training",
      rules: ["cite source tier for all factual claims", "no numeric claims unless cited from T1/T2"],
      outputSchema: { answer: true, factsUsed: true, assumptions: false, unknowns: true, confidence: false },
    };

    const prompt = buildRepairPrompt(
      "What does Khan do?",
      ["Numeric claims detected without source attribution"],
      contract,
    );

    expect(prompt).toContain("Numeric claims detected");
    expect(prompt).toContain("cite source tier for all factual claims");
    expect(prompt).toContain("no numeric claims unless cited from T1/T2");
    expect(prompt).toContain("answer, factsUsed, unknowns");
  });
});

// ─── VALIDATION_DISCLAIMER ──────────────────────────────────

describe("VALIDATION_DISCLAIMER", () => {
  it("is a short, non-theatrical one-liner", () => {
    expect(VALIDATION_DISCLAIMER).toContain("⚠️");
    expect(VALIDATION_DISCLAIMER).toContain("general guidance");
    // Should be a single line
    expect(VALIDATION_DISCLAIMER.split("\n")).toHaveLength(1);
  });
});

// ─── MicroRunner Orchestrator ───────────────────────────────

describe("createMicroRunner", () => {
  describe("prepare()", () => {
    it("compiles, gates, and augments in one call", () => {
      const lookup = makeOfficerLookup([KHAN]);
      const ctx = makeContextSources({ hasRoster: true, lookupOfficer: lookup });
      const runner = createMicroRunner({ contextSources: ctx, knownOfficerNames: ["Khan"] });

      const { contract, gatedContext, augmentedMessage } = runner.prepare("Tell me about Khan");

      expect(contract.taskType).toBe("reference_lookup");
      expect(gatedContext.contextBlock).toContain("Officer \"Khan\"");
      expect(augmentedMessage).toContain("[CONTEXT FOR THIS QUERY");
      expect(augmentedMessage).toContain("Tell me about Khan");
    });

    it("passes through strategy_general without context block", () => {
      const ctx = makeContextSources();
      const runner = createMicroRunner({ contextSources: ctx });

      const { contract, gatedContext, augmentedMessage } = runner.prepare("How do armadas work?");

      expect(contract.taskType).toBe("strategy_general");
      expect(gatedContext.contextBlock).toBeNull();
      expect(augmentedMessage).toBe("How do armadas work?");
    });
  });

  describe("validate()", () => {
    it("returns needsRepair=false when validation passes", () => {
      const ctx = makeContextSources();
      const runner = createMicroRunner({ contextSources: ctx });
      const { contract, gatedContext } = runner.prepare("How do armadas work?");

      const result = runner.validate(
        "Armadas are cooperative fleet battles...",
        contract,
        gatedContext,
        "test-session",
        Date.now() - 100,
      );

      expect(result.needsRepair).toBe(false);
      expect(result.repairPrompt).toBeNull();
      expect(result.receipt.validationResult).toBe("pass");
    });

    it("returns needsRepair=true with repair prompt when validation fails", () => {
      const ctx = makeContextSources({ hasRoster: true });
      const runner = createMicroRunner({ contextSources: ctx, knownOfficerNames: ["Khan"] });
      const { contract, gatedContext } = runner.prepare("Tell me about Khan");

      const result = runner.validate(
        "Khan has level 40 with power 1.2M and does +25% damage to all enemies.",
        contract,
        gatedContext,
        "test-session",
        Date.now() - 100,
      );

      expect(result.needsRepair).toBe(true);
      expect(result.repairPrompt).toBeTruthy();
      expect(result.receipt.validationResult).toBe("fail");
    });

    it("produces a receipt with correct structure", () => {
      const lookup = makeOfficerLookup([KHAN]);
      const ctx = makeContextSources({ hasRoster: true, lookupOfficer: lookup });
      const runner = createMicroRunner({ contextSources: ctx, knownOfficerNames: ["Khan"] });
      const { contract, gatedContext } = runner.prepare("Tell me about Khan");

      const result = runner.validate(
        "According to the imported reference data, Khan is an augment officer.",
        contract,
        gatedContext,
        "session-123",
        Date.now() - 50,
      );

      expect(result.receipt.sessionId).toBe("session-123");
      expect(result.receipt.taskType).toBe("reference_lookup");
      expect(result.receipt.contextManifest).toContain("T2 reference(Khan)");
      expect(result.receipt.contextKeysInjected).toContain("t2:officer:khan");
      expect(result.receipt.t2Provenance).toHaveLength(1);
      expect(result.receipt.t2Provenance[0].source).toBe("STFC wiki");
      expect(result.receipt.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.receipt.timestamp).toBeTruthy();
    });
  });
});
