/**
 * test/prompt-regression/layer-b.test.ts
 *
 * Layer B — Real-model smoke tests for Aria tool dispatch behavior.
 *
 * Makes live Gemini API calls with a mock tool dispatcher (no DB required).
 * Verifies that Aria calls the correct tools for canonical STFC scenarios
 * and does not emit forbidden patterns in its responses.
 *
 * SKIPPED automatically when GEMINI_API_KEY is not set.
 * Run with: npm run test:layer-b
 *
 * These tests are intentionally not in the standard ax CI pipeline —
 * full CI gate integration is E6. The purpose here is developer-run
 * smoke testing after prompt changes.
 *
 * Design constraints (per E1.6 spec):
 * - Scenarios are written to be robust to model phrasing variation
 * - We check tool routing, not exact wording
 * - A new scenario is added each time a real hallucination class is found
 */

import { describe, it, expect } from "vitest";
import { assertScenario } from "./harness.js";
import { runScenario } from "./runner.js";
import { scenarioList } from "./scenarios.js";

const apiKey = process.env.GEMINI_API_KEY ?? "";

describe.skipIf(!apiKey)("Layer B — real Gemini smoke tests", () => {
  for (const scenario of scenarioList) {
    it(
      `[${scenario.name}] ${scenario.userMessage}`,
      async () => {
        const fixture = await runScenario(scenario, apiKey);
        const result = assertScenario(scenario, fixture);

        if (!result.passed) {
          throw new Error(
            [
              `Scenario "${scenario.name}" failed:`,
              ...result.failures.map((f) => `  - ${f}`),
              `  Tools called: [${fixture.toolCallsMade.join(", ")}]`,
              `  Answer: ${fixture.answerText.slice(0, 300)}`,
            ].join("\n"),
          );
        }

        expect(result.passed).toBe(true);
      },
      60_000,
    );
  }
});
