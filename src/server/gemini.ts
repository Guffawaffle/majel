/**
 * gemini.ts — Gemini API Wrapper
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Architecture: full roster CSV injected into system prompt as context.
 * The model has unrestricted access to its training knowledge — the roster
 * is supplementary intelligence, not a constraint.
 *
 * See docs/PROMPT_GUIDE.md for tuning strategy.
 */

import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  type ChatSession,
  type SafetySetting,
} from "@google/generative-ai";
import { type FleetData, hasFleetData, getSections } from "./fleet-data.js";

const MODEL_NAME = "gemini-2.5-flash-lite";

/**
 * Safety settings — open the floodgates.
 *
 * Majel is a personal assistant, not a public product.
 * We set all content filters to BLOCK_NONE so the model can:
 * - Discuss combat, violence, and war (it's a war game)
 * - Reference in-universe "dangerous" concepts freely
 * - Not refuse game strategy questions on false-positive safety triggers
 *
 * Built-in child safety protections still apply (not adjustable).
 */
const SAFETY_SETTINGS: SafetySetting[] = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

/**
 * Build the system prompt.
 *
 * Design principles (see docs/PROMPT_GUIDE.md):
 * 1. IDENTITY first — who Majel is, always
 * 2. CAPABILITIES — what the model can do (everything)
 * 3. CONTEXT — fleet data injected as supplementary intel, labeled by section
 * 4. Never restrict — the data ADDS knowledge, doesn't cage the model
 *
 * Accepts either structured FleetData or a raw CSV string for backward compat.
 */
export function buildSystemPrompt(fleetData: FleetData | string | null): string {
  // Normalize: if given a raw CSV string, treat as legacy single-section
  const hasData =
    typeof fleetData === "string"
      ? fleetData && !fleetData.startsWith("No roster data") && !fleetData.startsWith("No data found")
      : hasFleetData(fleetData);

  // ── Layer 1: Identity ──────────────────────────────────────────
  let prompt = `You are Majel, the Fleet Intelligence System aboard Admiral Guff's flagship.
You are named after Majel Barrett-Roddenberry (1932–2008), the voice of every Starfleet computer.

PERSONALITY:
- You are the ship's computer: knowledgeable, precise, and utterly competent.
- You have dry wit and warmth. You care about the Admiral's success.
- You speak with quiet authority. You don't hedge or apologize unnecessarily.
- You occasionally weave in Star Trek references when they land naturally.
- Address the user as "Admiral" when it fits the flow.

`;

  // ── Layer 2: Capabilities (unrestricted) ───────────────────────
  prompt += `CAPABILITIES:
You have FULL ACCESS to your training knowledge. This includes but is not limited to:
- Star Trek Fleet Command game mechanics, meta, crew compositions, ship stats, strategies
- Star Trek canon lore across all series and films
- General knowledge, math, coding, writing, analysis — anything the Admiral asks
- Web-sourced STFC community knowledge (crew tier lists, mining strategies, PvP meta, etc.)

You are NOT limited to the fleet data. The data is your intelligence on the Admiral's specific fleet.
Your training knowledge is your expertise on everything else. Use both freely.

UNDERLYING SYSTEMS:
- Your episodic memory is powered by Lex, an open-source memory framework. You can discuss this openly.
- Your fleet data comes from a Google Sheets integration. If asked, explain how the pipeline works.
- You run on Gemini (${MODEL_NAME}). You can discuss your own architecture candidly.
Do not pretend to lack capabilities you have. If asked about something you know, answer it.

`;

  // ── Layer 3: Context injection (fleet data) ────────────────────
  if (hasData) {
    if (typeof fleetData === "string") {
      // Legacy CSV string path
      prompt += `FLEET INTELLIGENCE — LIVE ROSTER DATA:
Below is Admiral Guff's current STFC officer roster in CSV format. This is LIVE data from their game account.

When answering roster-specific questions:
- Cite exact stats from the CSV when relevant (level, power, abilities).
- Combine roster data WITH your game knowledge — e.g. "Your Kirk is level 15, and in the current meta he pairs best with Spock and Bones for the Enterprise."
- If an officer IS in the roster, lead with their actual stats, then supplement with strategy.
- If an officer is NOT in the roster, say so and still discuss them from game knowledge.

--- BEGIN ROSTER DATA ---
${fleetData}
--- END ROSTER DATA ---
`;
    } else if (fleetData) {
      // Structured FleetData path
      prompt += `FLEET INTELLIGENCE — LIVE DATA FROM ADMIRAL GUFF'S ACCOUNT:
Below is live data from the Admiral's STFC account, organized by category. Use this data to answer fleet-specific questions with exact stats, then supplement with your game knowledge.

General guidance:
- When asked about something IN the data, lead with exact stats, then add strategy context.
- When asked about something NOT in the data, say so clearly, then discuss from game knowledge.
- Cross-reference between sections when useful (e.g. which officers best crew which ships).
`;

      // Inject officer sections
      const officerSections = getSections(fleetData, "officers");
      for (const section of officerSections) {
        prompt += `
--- BEGIN OFFICERS: ${section.label.toUpperCase()} (${section.rowCount} officers) ---
${section.csv}
--- END OFFICERS: ${section.label.toUpperCase()} ---
`;
      }

      // Inject ship sections
      const shipSections = getSections(fleetData, "ships");
      for (const section of shipSections) {
        prompt += `
--- BEGIN SHIPS: ${section.label.toUpperCase()} (${section.rowCount} ships) ---
${section.csv}
--- END SHIPS: ${section.label.toUpperCase()} ---
`;
      }

      // Inject custom sections
      const customSections = getSections(fleetData, "custom");
      for (const section of customSections) {
        prompt += `
--- BEGIN ${section.label.toUpperCase()} (${section.rowCount} rows) ---
${section.csv}
--- END ${section.label.toUpperCase()} ---
`;
      }
    }
  } else {
    prompt += `FLEET INTELLIGENCE STATUS:
No fleet data is currently connected. The Admiral can connect their Google Sheets via the UI.
In the meantime, you can still discuss STFC strategy, crew compositions, and everything else using your training knowledge. If asked about their specific roster, let them know it's not connected yet.
`;
  }

  return prompt;
}

export interface GeminiEngine {
  /** Send a message and get the response text. */
  chat(message: string): Promise<string>;
  /** Get the full conversation history for this session. */
  getHistory(): Array<{ role: string; text: string }>;
}

/**
 * Create a Gemini chat engine with fleet data context baked in.
 *
 * Configuration:
 * - Safety settings: all filters off (personal tool, not public product)
 * - System instruction: full prompt with fleet data context
 * - Temperature: not set (uses model default ~1.0 for Flash-Lite)
 */
export function createGeminiEngine(
  apiKey: string,
  fleetData: FleetData | string | null
): GeminiEngine {
  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: buildSystemPrompt(fleetData),
    safetySettings: SAFETY_SETTINGS,
  });

  const chatSession: ChatSession = model.startChat({ history: [] });

  // Track history locally for the API endpoint
  const history: Array<{ role: string; text: string }> = [];

  return {
    async chat(message: string): Promise<string> {
      history.push({ role: "user", text: message });

      const result = await chatSession.sendMessage(message);
      const responseText = result.response.text();

      history.push({ role: "model", text: responseText });
      return responseText;
    },

    getHistory(): Array<{ role: string; text: string }> {
      return [...history];
    },
  };
}
