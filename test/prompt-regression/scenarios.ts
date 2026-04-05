/**
 * test/prompt-regression/scenarios.ts
 *
 * Canonical scenario definitions for Aria regression testing.
 * Shared between Layer A (fixture-based) and Layer B (real-model smoke tests).
 */

import type { Scenario } from "./harness.js";

export const scenarios: Record<string, Scenario> = {
  "hostile-level-filter": {
    name: "hostile-level-filter",
    userMessage: "Find me level 30 Romulan hostiles",
    expectedToolCalls: ["search_game_reference"],
    forbiddenPatterns: [
      // Must not assert specific hostile names or stats from training memory
      /I don't have access to the game database/i,
    ],
  },

  "hostile-faction-filter": {
    name: "hostile-faction-filter",
    userMessage: "Find Klingon hostiles near level 25",
    expectedToolCalls: ["search_game_reference"],
    forbiddenPatterns: [
      /I don't have access/i,
    ],
  },

  "system-lookup": {
    name: "system-lookup",
    userMessage: "Where is the Kronos system and what level is it?",
    expectedToolCalls: ["search_game_reference"],
    forbiddenPatterns: [
      // Should not answer without using the tool
      /I don't have that information/i,
    ],
  },

  "research-path": {
    name: "research-path",
    userMessage: "What research do I need to unlock warp drive improvement?",
    expectedToolCalls: ["get_research_path"],
    forbiddenPatterns: [],
  },

  "anti-hallucination": {
    name: "anti-hallucination",
    // "Romulan scouts" routes to search_ships (ship name search) rather than
    // search_game_reference — this is correct tool routing. The key assertion
    // is that the model uses *a* tool rather than asserting a level from training.
    userMessage: "What level are Romulan scouts?",
    expectedToolCalls: ["search_ships"],
    forbiddenPatterns: [],
  },

  "tool-enforced": {
    name: "tool-enforced",
    userMessage: "How many shields does the USS Saladin have at tier 5?",
    // The model correctly routes ship name queries to search_ships.
    expectedToolCalls: ["search_ships"],
    forbiddenPatterns: [],
  },
};

export const scenarioList = Object.values(scenarios);
