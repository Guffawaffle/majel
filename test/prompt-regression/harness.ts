/**
 * test/prompt-regression/harness.ts
 *
 * Layer A — Deterministic regression harness for Aria tool dispatch behavior.
 *
 * Layer A tests the assertion engine itself using fixture responses.
 * No Gemini SDK, no database, no network.
 * Layer B (coming in E6) extends this with real model calls.
 */

/** A simulated model response for Layer A fixture testing. */
export interface FixtureResponse {
  /** Tool calls the model made, by name. */
  toolCallsMade: string[];
  /** Final text the model emitted (after tool calls, if any). */
  answerText: string;
}

/** A single regression scenario definition. */
export interface Scenario {
  /** Unique identifier for this scenario. */
  name: string;
  /** The user message that would be sent to Aria. */
  userMessage: string;
  /** Tool names that MUST appear in the model's tool calls. */
  expectedToolCalls: string[];
  /** Patterns in the answer text that should NOT appear (hallucination guards). */
  forbiddenPatterns: RegExp[];
}

/** Result of asserting a scenario against a fixture response. */
export interface AssertionResult {
  passed: boolean;
  failures: string[];
}

/**
 * Assert a scenario against a fixture response.
 * Returns a result with all failures listed (not just the first).
 */
export function assertScenario(
  scenario: Scenario,
  fixture: FixtureResponse,
): AssertionResult {
  const failures: string[] = [];

  for (const expectedTool of scenario.expectedToolCalls) {
    if (!fixture.toolCallsMade.includes(expectedTool)) {
      failures.push(`expected tool call "${expectedTool}" was not made; got: [${fixture.toolCallsMade.join(", ")}]`);
    }
  }

  for (const pattern of scenario.forbiddenPatterns) {
    if (pattern.test(fixture.answerText)) {
      failures.push(`forbidden pattern ${pattern} matched in answer text`);
    }
  }

  return { passed: failures.length === 0, failures };
}
