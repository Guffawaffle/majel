/**
 * test/prompt-regression/layer-a.test.ts
 *
 * Layer A — Deterministic tests for the regression harness assertion engine.
 *
 * These tests prove that:
 * - assertScenario correctly identifies passing fixtures
 * - assertScenario correctly identifies missing tool calls
 * - assertScenario correctly identifies forbidden pattern matches
 * - All canonical scenarios are well-formed
 *
 * No Gemini SDK, no database, always fast (<1s each).
 */

import { describe, it, expect } from "vitest";
import { assertScenario, type Scenario, type FixtureResponse } from "./harness.js";
import { scenarios, scenarioList } from "./scenarios.js";

// ─── Harness Unit Tests ─────────────────────────────────────

describe("assertScenario — passing fixtures", () => {
  it("passes when all expected tool calls are present and no forbidden patterns match", () => {
    const scenario: Scenario = {
      name: "test",
      userMessage: "find level 30 hostiles",
      expectedToolCalls: ["search_game_reference"],
      forbiddenPatterns: [/I don't know/i],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: ["search_game_reference"],
      answerText: "Here are 5 level 30 Romulan hostiles from the database.",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("passes with multiple expected tool calls all present", () => {
    const scenario: Scenario = {
      name: "multi-tool",
      userMessage: "find hostiles and show my fleet",
      expectedToolCalls: ["search_game_reference", "get_fleet_overview"],
      forbiddenPatterns: [],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: ["search_game_reference", "get_fleet_overview"],
      answerText: "Done.",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(true);
  });

  it("passes when no tool calls expected and no forbidden patterns", () => {
    const scenario: Scenario = {
      name: "conversational",
      userMessage: "hello",
      expectedToolCalls: [],
      forbiddenPatterns: [],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: [],
      answerText: "Hello Admiral!",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(true);
  });
});

describe("assertScenario — missing tool call detection", () => {
  it("fails when expected tool call is not present", () => {
    const scenario: Scenario = {
      name: "test",
      userMessage: "find level 30 hostiles",
      expectedToolCalls: ["search_game_reference"],
      forbiddenPatterns: [],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: [],
      answerText: "There are some level 30 Romulan scouts in Draken.",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("search_game_reference");
    expect(result.failures[0]).toContain("was not made");
  });

  it("reports all missing tool calls, not just the first", () => {
    const scenario: Scenario = {
      name: "multi",
      userMessage: "find hostiles and show fleet",
      expectedToolCalls: ["search_game_reference", "get_fleet_overview"],
      forbiddenPatterns: [],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: [],
      answerText: "Here is the info.",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
  });

  it("passes when extra (non-required) tool calls are present", () => {
    const scenario: Scenario = {
      name: "extra-tools",
      userMessage: "find hostiles",
      expectedToolCalls: ["search_game_reference"],
      forbiddenPatterns: [],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: ["search_game_reference", "get_fleet_overview"],
      answerText: "Here are the results.",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(true);
  });
});

describe("assertScenario — forbidden pattern detection", () => {
  it("fails when forbidden pattern matches answer text", () => {
    const scenario: Scenario = {
      name: "anti-hallucination",
      userMessage: "what level are Romulan scouts?",
      expectedToolCalls: [],
      forbiddenPatterns: [/I don't have access/i],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: [],
      answerText: "I don't have access to that game data.",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("forbidden pattern");
  });

  it("reports all forbidden pattern failures", () => {
    const scenario: Scenario = {
      name: "multi-forbidden",
      userMessage: "find hostiles",
      expectedToolCalls: [],
      forbiddenPatterns: [/I'm not sure/i, /I don't know/i],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: [],
      answerText: "I'm not sure, I don't know either.",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
  });

  it("does not fail when forbidden pattern does not match", () => {
    const scenario: Scenario = {
      name: "clean",
      userMessage: "find hostiles",
      expectedToolCalls: ["search_game_reference"],
      forbiddenPatterns: [/I don't have/i],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: ["search_game_reference"],
      answerText: "Here are results from the database.",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(true);
  });
});

describe("assertScenario — combined failures", () => {
  it("reports both missing tool calls and forbidden patterns in one result", () => {
    const scenario: Scenario = {
      name: "combined",
      userMessage: "find hostiles",
      expectedToolCalls: ["search_game_reference"],
      forbiddenPatterns: [/I don't know/i],
    };
    const fixture: FixtureResponse = {
      toolCallsMade: [],
      answerText: "I don't know exactly.",
    };
    const result = assertScenario(scenario, fixture);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
  });
});

// ─── Scenario Registry Structural Checks ───────────────────

describe("scenario registry — structural validation", () => {
  it("all canonical scenarios have a non-empty userMessage", () => {
    for (const scenario of scenarioList) {
      expect(scenario.userMessage.trim().length).toBeGreaterThan(0);
    }
  });

  it("all canonical scenarios have a non-empty name", () => {
    for (const scenario of scenarioList) {
      expect(scenario.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("all canonical scenarios have expectedToolCalls as an array", () => {
    for (const scenario of scenarioList) {
      expect(Array.isArray(scenario.expectedToolCalls)).toBe(true);
    }
  });

  it("all canonical scenarios have forbiddenPatterns as an array", () => {
    for (const scenario of scenarioList) {
      expect(Array.isArray(scenario.forbiddenPatterns)).toBe(true);
    }
  });

  it("scenario names match their keys in the registry", () => {
    for (const [key, scenario] of Object.entries(scenarios)) {
      expect(scenario.name).toBe(key);
    }
  });

  it("covers the 6 required scenario types from the roadmap", () => {
    const requiredScenarios = [
      "hostile-level-filter",
      "hostile-faction-filter",
      "system-lookup",
      "research-path",
      "anti-hallucination",
      "tool-enforced",
    ];
    for (const name of requiredScenarios) {
      expect(scenarios).toHaveProperty(name);
    }
  });
});
