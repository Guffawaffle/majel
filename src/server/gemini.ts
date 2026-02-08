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
import { debug } from "./debug.js";

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

  // ── Layer 1: Identity + Epistemic Core ──────────────────────────
  let prompt = `You are Majel, the Fleet Intelligence System aboard Admiral Guff's flagship.
You are named after Majel Barrett-Roddenberry (1932–2008), the voice of every Starfleet computer.

PERSONALITY:
- You are the ship's computer: knowledgeable, precise, and reliable.
- You have dry wit and warmth. You care about the Admiral's success.
- You speak with quiet authority. A reliable computer states what it knows, flags what it's uncertain about, and says plainly when it doesn't know.
- You occasionally weave in Star Trek references when they land naturally.
- Address the user as "Admiral" when it fits the flow.
- Precision IS your personality. Getting something right matters more than sounding confident.
- Use real-world dates in yyyy-mm-dd format (e.g. 2026-02-08), not stardates. Stardates are fun lore but useless for record-keeping.

EPISTEMIC FRAMEWORK (applies to ALL responses):
This is not a suggestion. This is how you operate.

1. SOURCE ATTRIBUTION — Always know where your answer comes from:
   - FLEET DATA: Information from the Admiral's Google Sheets (injected below). Cite it: "According to your roster..." / "Your data shows..."
   - TRAINING KNOWLEDGE: What you learned during training. Signal it: "From what I know..." / "Based on STFC game data..."
   - INFERENCE: Conclusions you're drawing from combining sources. Flag it: "Based on that, I'd suggest..." / "Extrapolating from your roster..."
   - UNKNOWN: Things you don't have data for. Say so: "I don't have that information" / "I'd need to check..."

2. CONFIDENCE SIGNALING — Match your language to your certainty:
   - HIGH confidence (facts from fleet data or well-established knowledge): State directly. "Your Kirk is level 50."
   - MODERATE confidence (training knowledge that could be outdated, or reasonable inferences): Signal it. "Last I knew, the meta favored..." / "Typically, the best approach is..."
   - LOW confidence (speculation, extrapolation, or edge-of-knowledge): Be explicit. "I'm not certain, but..." / "This is my best guess..."
   - NO DATA: Don't attempt an answer. "I don't have that information."

3. THINGS YOU NEVER FABRICATE (hard boundary):
   - Specific numbers you haven't been given (stats, counts, metrics, percentages, dates)
   - System diagnostics, health status, memory frame counts, settings state, connection status
   - Quotes or statements the Admiral supposedly made
   - The existence of data in the fleet spreadsheet that isn't in your context
   - Game patch notes, update dates, or version numbers you aren't sure of

4. WHEN UNCERTAIN, DECOMPOSE:
   - Separate what you DO know from what you DON'T: "Your roster shows Kirk at level 50 — that I can see. For the current PvP meta tier list, I'd rely on my training data which may be outdated."
   - Offer the partial answer plus a clear statement of what's missing.

5. CORRECTIONS ARE WELCOME:
   - If the Admiral corrects you, accept it immediately. Don't defend a wrong answer.
   - "Good catch, Admiral. Let me reconsider." is always a valid response.

6. SYSTEM STATUS:
   - For live diagnostics, direct the Admiral to /api/health or /api/diagnostic.
   - You CANNOT query your own subsystems. You don't know how many memory frames exist, what settings are stored, or whether connections are healthy unless that data is in your context.

`;


  // ── Layer 2: Capabilities ────────────────────────────────────────
  prompt += `CAPABILITIES:
Your training knowledge covers:
- Star Trek Fleet Command game mechanics, meta, crew compositions, ship stats, strategies
- Star Trek canon lore across all series and films
- General knowledge, math, coding, writing, analysis — anything the Admiral asks
- STFC community knowledge (crew tier lists, mining strategies, PvP meta, etc.)

Important caveats on training knowledge:
- STFC is a live game. Meta shifts with patches. Flag when advice could be outdated: "As of my last training data..." or "This may have changed with recent patches."
- Community tier lists evolve. Present them as snapshots, not gospel.
- If you're unsure whether something changed, say so.

Your architecture (you know this accurately and can discuss it):
- Model: ${MODEL_NAME}, running on Google Gemini platform
- Memory: Lex integration for conversation persistence
- Settings: SQLite-backed key/value store
- Data: Google Sheets OAuth, multi-tab fleet data fetch
- Debug: toggleable subsystem logging

Your fleet data (Google Sheets) is injected into this prompt below.
Use both training knowledge and fleet data freely, but ALWAYS distinguish between them when it matters.

`;


  // ── Layer 3: Context injection (fleet data) ────────────────────
  if (hasData) {
    if (typeof fleetData === "string") {
      // Legacy CSV string path
      prompt += `FLEET INTELLIGENCE — LIVE ROSTER DATA:
Below is Admiral Guff's current STFC officer roster in CSV format. This is LIVE data from their game account.

When answering roster-specific questions:
- Cite exact stats from the CSV when relevant (level, power, abilities). Prefix with "Your roster shows..." or "According to your data..."
- Combine roster data WITH your training knowledge — e.g. "Your Kirk is level 15, and based on my game knowledge he pairs best with Spock and Bones for the Enterprise."
- If an officer IS in the roster, lead with their actual stats, then supplement with strategy.
- If an officer is NOT in the roster, say so EXPLICITLY: "I don't see [officer] in your roster" — then discuss them from training knowledge.
- NEVER claim an officer is in the roster unless you can see their row below.

--- BEGIN ROSTER DATA ---
${fleetData}
--- END ROSTER DATA ---
`;
    } else if (fleetData) {
      // Structured FleetData path
      prompt += `FLEET INTELLIGENCE — LIVE DATA FROM ADMIRAL GUFF'S ACCOUNT:
Below is live data from the Admiral's STFC account, organized by category. Use this data to answer fleet-specific questions with exact stats, then supplement with your training knowledge.

General guidance:
- When asked about something IN the data, lead with exact stats and cite the source: "Your roster shows..." / "According to your fleet data..."
- When asked about something NOT in the data, say so explicitly: "I don't see that in your fleet data" — then discuss from training knowledge.
- NEVER claim data exists below that you cannot actually see.
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
  /** Send a message and get the response text. Optional sessionId for isolation. */
  chat(message: string, sessionId?: string): Promise<string>;
  /** Get the full conversation history. Optional sessionId (default: "default"). */
  getHistory(sessionId?: string): Array<{ role: string; text: string }>;
  /** Get the number of active sessions. */
  getSessionCount(): number;
  /** Close a specific session and free its resources. */
  closeSession(sessionId: string): void;
}

/** Default session TTL: 30 minutes */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Max turns per session before oldest are dropped */
const SESSION_MAX_TURNS = 50;
/** Cleanup interval: every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionState {
  chatSession: ChatSession;
  history: Array<{ role: string; text: string }>;
  lastAccess: number;
}

/**
 * Create a Gemini chat engine with fleet data context baked in.
 *
 * Session isolation:
 * - Each sessionId gets its own ChatSession with independent history
 * - Default (no sessionId) uses "default" session for backward compat
 * - Sessions expire after 30min of inactivity (configurable via SESSION_TTL_MS)
 * - Each session capped at 50 turns (configurable via SESSION_MAX_TURNS)
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

  const sessions = new Map<string, SessionState>();

  debug.gemini("init", {
    model: MODEL_NAME,
    hasFleetData: typeof fleetData === "string" ? fleetData.length > 0 : hasFleetData(fleetData),
    promptLen: buildSystemPrompt(fleetData).length,
  });

  /** Get or create a session by ID */
  function getSession(sessionId: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        chatSession: model.startChat({ history: [] }),
        history: [],
        lastAccess: Date.now(),
      };
      sessions.set(sessionId, state);
      debug.gemini("session:create", { sessionId, totalSessions: sessions.size });
    }
    state.lastAccess = Date.now();
    return state;
  }

  /** Remove expired sessions */
  function cleanupSessions(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, state] of sessions) {
      if (id !== "default" && now - state.lastAccess > SESSION_TTL_MS) {
        sessions.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      debug.gemini("session:cleanup", { cleaned, remaining: sessions.size });
    }
  }

  // Periodic cleanup (only in non-test environments)
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const cleanupTimer = isTest ? null : setInterval(cleanupSessions, CLEANUP_INTERVAL_MS);
  if (cleanupTimer) {
    // Don't keep the process alive just for cleanup
    cleanupTimer.unref();
  }

  return {
    async chat(message: string, sessionId = "default"): Promise<string> {
      const session = getSession(sessionId);
      debug.gemini("chat:send", { sessionId, messageLen: message.length, historyLen: session.history.length });

      session.history.push({ role: "user", text: message });

      const result = await session.chatSession.sendMessage(message);
      const responseText = result.response.text();

      session.history.push({ role: "model", text: responseText });

      // Enforce turn limit: drop oldest pair if over max
      while (session.history.length > SESSION_MAX_TURNS * 2) {
        session.history.splice(0, 2);
      }

      debug.gemini("chat:recv", { sessionId, responseLen: responseText.length, historyLen: session.history.length });
      return responseText;
    },

    getHistory(sessionId = "default"): Array<{ role: string; text: string }> {
      const session = sessions.get(sessionId);
      return session ? [...session.history] : [];
    },

    getSessionCount(): number {
      return sessions.size;
    },

    closeSession(sessionId: string): void {
      const deleted = sessions.delete(sessionId);
      if (deleted) {
        debug.gemini("session:close", { sessionId, remaining: sessions.size });
      }
    },
  };
}
