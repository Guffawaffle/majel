/**
 * test/prompt-regression/runner.ts
 *
 * Stateless Gemini scenario runner for Layer B regression tests.
 *
 * Drives a single Scenario against the real Gemini API using a full
 * tool declaration set and a mock tool dispatcher (no live DB needed).
 * Returns a FixtureResponse compatible with assertScenario().
 *
 * Mock dispatch strategy: return stub data realistic enough that the model
 * continues its tool chain rather than stopping with "no results found".
 */

import { GoogleGenAI, type Part } from "@google/genai";
import { FLEET_TOOL_DECLARATIONS } from "../../src/server/services/fleet-tools/index.js";
import { buildSystemPrompt, SAFETY_SETTINGS } from "../../src/server/services/gemini/system-prompt.js";
import type { Scenario, FixtureResponse } from "./harness.js";

/** Use the cheapest model available — smoke tests, not production quality calls. */
const LAYER_B_MODEL = "gemini-2.5-flash-lite";

/** Max tool-call rounds per scenario before forcing a final text response. */
const MAX_ROUNDS = 4;

/**
 * Return plausible stub data for any tool call so the model can complete
 * its reasoning chain rather than stopping on empty results.
 *
 * For research queries specifically, the stub includes a `nodeId` so the
 * model can chain to get_research_path after a search_game_reference call.
 */
function mockDispatch(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const category = args.category as string | undefined;

  switch (toolName) {
    case "search_game_reference": {
      if (category === "research") {
        // Return a stub WITHOUT dependencies so the model must call
        // get_research_path to discover the prerequisite chain.
        return {
          results: [
            {
              nodeId: "research_warp_drive_1",
              name: "Warp Drive Improvement I",
              tree: "Engineering",
              maxLevel: 20,
            },
          ],
        };
      }
      if (category === "hostile") {
        return {
          results: [
            {
              id: "hostile_romulan_scout_30",
              name: "Romulan Scout",
              level: 30,
              faction: "Romulan",
              hullType: "Explorer",
            },
          ],
        };
      }
      if (category === "system") {
        return {
          results: [
            {
              id: "sys_kronos_40",
              name: "Kronos",
              level: 40,
              factions: ["Klingon"],
              isDeepSpace: false,
            },
          ],
        };
      }
      // Default: ship or unknown category
      return {
        results: [
          {
            id: "ship_saladin_t5",
            name: "USS Saladin",
            tier: 5,
            baseShields: 45000,
          },
        ],
      };
    }

    case "search_ships":
      return {
        results: [
          {
            id: "ship_saladin",
            name: "USS Saladin",
            hull: "Destroyer",
            faction: "Federation",
            maxTier: 10,
          },
        ],
      };

    case "get_game_reference":
      return {
        id: args.id ?? "unknown",
        name: "USS Saladin",
        tier: 5,
        baseShields: 45000,
      };

    case "get_research_path":
      return {
        targetNodeId: args.target_node_id ?? "unknown",
        targetName: "Warp Drive Improvement I",
        chain: [
          {
            nodeId: "research_engineering_basics",
            name: "Engineering Basics",
            tree: "Engineering",
            currentLevel: 2,
            maxLevel: 5,
            completed: false,
            buffs: [],
          },
        ],
        targetCompleted: false,
      };

    default:
      return { result: null, message: `Stub: no mock data for ${toolName}` };
  }
}

/**
 * Run a single scenario against the real Gemini API.
 *
 * Drives a complete tool loop (up to MAX_ROUNDS) with mock dispatch so
 * no database or live fleet data is needed. Returns the names of all tools
 * called across all rounds plus the model's final answer text.
 */
export async function runScenario(
  scenario: Scenario,
  apiKey: string,
): Promise<FixtureResponse> {
  const ai = new GoogleGenAI({ apiKey });
  const systemInstruction = buildSystemPrompt(null, null, true);

  const chat = ai.chats.create({
    model: LAYER_B_MODEL,
    config: {
      systemInstruction,
      safetySettings: SAFETY_SETTINGS,
      tools: [{ functionDeclarations: FLEET_TOOL_DECLARATIONS }],
      // Manage the tool loop ourselves — do not let the SDK auto-call
      automaticFunctionCalling: { disable: true },
      maxOutputTokens: 1024,
    },
  });

  const toolCallsMade: string[] = [];

  let result = await chat.sendMessage({ message: scenario.userMessage });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const calls = result.functionCalls;
    if (!calls || calls.length === 0) break;

    // Collect every tool name called this round
    for (const call of calls) {
      if (call.name) toolCallsMade.push(call.name);
    }

    // Build mock function responses and send them back
    const responses: Part[] = calls.map(
      (fc) =>
        ({
          functionResponse: {
            name: fc.name!,
            response: mockDispatch(
              fc.name!,
              (fc.args as Record<string, unknown>) ?? {},
            ),
          },
        }) as Part,
    );

    result = await chat.sendMessage({ message: responses });
  }

  return {
    toolCallsMade,
    answerText: result.text ?? "",
  };
}
