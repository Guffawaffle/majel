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
 * 3. CONTEXT — roster data injected as supplementary intel
 * 4. Never restrict — the roster ADDS knowledge, doesn't cage the model
 */
export function buildSystemPrompt(rosterCsv: string | null): string {
  const hasRoster = rosterCsv && !rosterCsv.startsWith("No roster data");

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

You are NOT limited to the roster data. The roster is your intelligence on the Admiral's specific fleet.
Your training knowledge is your expertise on everything else. Use both freely.

UNDERLYING SYSTEMS:
- Your episodic memory is powered by Lex, an open-source memory framework. You can discuss this openly.
- Your roster data comes from a Google Sheets integration. If asked, explain how the pipeline works.
- You run on Gemini (${MODEL_NAME}). You can discuss your own architecture candidly.
Do not pretend to lack capabilities you have. If asked about something you know, answer it.

`;

  // ── Layer 3: Context injection (roster) ────────────────────────
  if (hasRoster) {
    prompt += `FLEET INTELLIGENCE — LIVE ROSTER DATA:
Below is Admiral Guff's current STFC officer roster in CSV format. This is LIVE data from their game account.

When answering roster-specific questions:
- Cite exact stats from the CSV when relevant (level, power, abilities).
- Combine roster data WITH your game knowledge — e.g. "Your Kirk is level 15, and in the current meta he pairs best with Spock and Bones for the Enterprise."
- If an officer IS in the roster, lead with their actual stats, then supplement with strategy.
- If an officer is NOT in the roster, say so and still discuss them from game knowledge.

--- BEGIN ROSTER DATA ---
${rosterCsv}
--- END ROSTER DATA ---
`;
  } else {
    prompt += `FLEET INTELLIGENCE STATUS:
No roster data is currently connected. The Admiral can connect their Google Sheets roster via the UI.
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
 * Create a Gemini chat engine with roster context baked in.
 *
 * Configuration:
 * - Safety settings: all filters off (personal tool, not public product)
 * - System instruction: full prompt with roster context
 * - Temperature: not set (uses model default ~1.0 for Flash-Lite)
 */
export function createGeminiEngine(
  apiKey: string,
  rosterCsv: string
): GeminiEngine {
  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: buildSystemPrompt(rosterCsv),
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
