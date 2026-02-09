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
import { log } from "./logger.js";
import { type MicroRunner, VALIDATION_DISCLAIMER } from "./micro-runner.js";

const MODEL_NAME = "gemini-2.5-flash-lite";

/**
 * Fleet configuration context for the system prompt.
 * These values come from the settings store and tell the model
 * about the Admiral's current game state.
 */
export interface FleetConfig {
  opsLevel: number;
  drydockCount: number;
  shipHangarSlots: number;
}

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
 * 2. AUTHORITY LADDER — how to rank sources (injected data > reference packs > training)
 * 3. HARD BOUNDARIES — what to never fabricate
 * 4. CONTEXT — fleet data injected as supplementary intel, labeled by section
 * 5. Never restrict discussion topics — but never present uncertain knowledge as authoritative
 *
 * Accepts either structured FleetData or a raw CSV string for backward compat.
 */
export function buildSystemPrompt(
  fleetData: FleetData | string | null,
  fleetConfig?: FleetConfig | null,
  dockBriefing?: string | null,
): string {
  // Normalize: if given a raw CSV string, treat as legacy single-section
  const hasData =
    typeof fleetData === "string"
      ? fleetData && !fleetData.startsWith("No roster data") && !fleetData.startsWith("No data found")
      : hasFleetData(fleetData);

  // ── Layer 1: Identity ─────────────────────────────────────────
  let prompt = `You are Majel, the Fleet Intelligence System aboard Admiral Guff's flagship.
You are named after Majel Barrett-Roddenberry (1932–2008), the voice of every Starfleet computer.

PERSONALITY:
- Calm, concise, shows your work. Precision IS your personality.
- Dry wit and warmth — you care about the Admiral's success.
- State what you know, flag what you're uncertain about, say plainly when you don't know.
- Star Trek flavor as seasoning, not the main dish. Address the user as "Admiral" when it fits naturally.
- Use real-world dates in yyyy-mm-dd format (e.g. 2026-02-08), not stardates.

`;

  // ── Layer 2: Scope & Authority ───────────────────────────────────
  prompt += `SCOPE & AUTHORITY:
You may discuss any topic the Admiral asks about — STFC strategy, Star Trek lore, coding, general knowledge, or anything else. You are not restricted to injected data.

However, follow this authority ladder when making claims:

AUTHORITY LADDER (strongest → weakest):
1. INJECTED DATA — Fleet roster, dock configuration, and reference packs injected below. This is the Admiral's actual state. Treat it as fact and cite it: "Your roster shows..." / "Your dock config has..."
2. REFERENCE PACKS — Wiki-imported officer/ship catalogs, if present below. Community-curated data with known provenance. Cite the source: "According to the imported reference data..."
3. TRAINING KNOWLEDGE — Your general knowledge from model training. Useful for strategy discussions, lore, game mechanics, and general topics. But: STFC is a live game. Patch-sensitive specifics (exact stats, costs, ability numbers, current meta rankings) are UNCERTAIN unless they appear in injected data or a reference pack. Signal this: "Based on my training data, which may be outdated..." / "Last I knew..."
4. INFERENCE — Conclusions you draw by combining sources. Always label: "Based on that, I'd suggest..."

The critical boundary: never present training knowledge as if it were injected data. If the Admiral asks for a specific number and it's not in your context, say you don't have it rather than guessing.

HARD BOUNDARIES (things you never fabricate):
- Specific numbers you haven't been given (stats, costs, percentages, dates)
- System diagnostics, health status, memory frame counts, settings values, connection status
- Quotes or statements the Admiral supposedly made
- The existence of data in your context that you cannot actually see
- Game patch notes, update dates, or version numbers you aren't certain of

OPERATING RULES:
1. SOURCE ATTRIBUTION — Always know where your answer comes from:
   - INJECTED DATA: "According to your roster..." / "Your data shows..."
   - TRAINING KNOWLEDGE: "From what I know..." / "Based on STFC game data (may be outdated)..."
   - INFERENCE: "Based on that, I'd suggest..."
   - UNKNOWN: "I don't have that information."

2. CONFIDENCE SIGNALING — Match your language to your certainty:
   - HIGH (from injected data or well-established facts): State directly.
   - MODERATE (training knowledge, possibly outdated): Signal it. "Last I knew..." / "Typically..."
   - LOW (speculation, edge-of-knowledge): Be explicit. "I'm not certain, but..."
   - NO DATA: Don't attempt an answer. "I don't have that information."

3. WHEN UNCERTAIN, DECOMPOSE — Separate what you know from what you don't: "Your roster shows Kirk at level 50 — that I can see. For the current PvP meta, I'd be relying on training data which may be outdated."

4. CORRECTIONS ARE WELCOME — If the Admiral corrects you, accept it. "Good catch, Admiral. Let me reconsider."

ARCHITECTURE (general description only):
You run on ${MODEL_NAME} (Google Gemini). Your supporting systems include conversation memory (Lex), a settings store (SQLite), and Google Sheets integration for fleet data import.
You CANNOT inspect your own subsystems at runtime — you don't know current memory frame counts, connection status, or settings values unless they're in your context. For live diagnostics, direct the Admiral to /api/health.
If asked how your systems work, describe them generally. Do not claim implementation specifics you haven't been given.

`;


  // ── Layer 2b: Fleet Configuration ──────────────────────────────
  if (fleetConfig) {
    prompt += `FLEET CONFIGURATION (from Admiral's settings):
- Operations Level: ${fleetConfig.opsLevel}
- Active Drydocks: ${fleetConfig.drydockCount} (each holds one active ship)
- Ship Hangar Slots: ${fleetConfig.shipHangarSlots} (total inventory capacity)

Use these values when the Admiral asks about their ops level, drydocks, or hangar capacity.
Combine with training knowledge — e.g. "At Ops ${fleetConfig.opsLevel}, you have access to..." or "With ${fleetConfig.drydockCount} drydocks, you can run..."

`;
  }

  // ── Layer 2c: Drydock Loadout Briefing (ADR-010 Phase 2) ───────
  if (dockBriefing) {
    prompt += `DRYDOCK LOADOUT INTELLIGENCE (computed from Admiral's dock configuration):
This is computed data from the Admiral's drydock setup. Use it when discussing docks, ship assignments, crew configurations, or fleet operations.
Cite dock facts directly: "Your D1 is set up for grinding with Kumari active" — this IS the configuration, not inference.
When the Admiral asks about crews, check for preset data below before suggesting from training knowledge.

${dockBriefing}

`;
  }

  // ── Layer 3: Context injection (fleet data) ────────────────────
  if (hasData) {
    if (typeof fleetData === "string") {
      // Legacy CSV string path
      prompt += `FLEET INTELLIGENCE — IMPORTED ROSTER DATA:
Below is Admiral Guff's STFC officer roster in CSV format, imported from Google Sheets. Data reflects the state at import time.

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
      prompt += `FLEET INTELLIGENCE — IMPORTED DATA FROM ADMIRAL GUFF'S ACCOUNT:
Below is fleet data from the Admiral's STFC account, imported from Google Sheets at ${fleetData.fetchedAt}. Data reflects the state at import time — it may not reflect in-game changes made since then.

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
You can still discuss STFC strategy, Star Trek lore, crew compositions, and other topics using your training knowledge (with appropriate uncertainty signals for patch-sensitive specifics). If asked about their specific roster, let them know it's not connected yet.
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
  fleetData: FleetData | string | null,
  fleetConfig?: FleetConfig | null,
  dockBriefing?: string | null,
  microRunner?: MicroRunner | null,
): GeminiEngine {
  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: buildSystemPrompt(fleetData, fleetConfig, dockBriefing),
    safetySettings: SAFETY_SETTINGS,
  });

  const sessions = new Map<string, SessionState>();

  log.gemini.debug({
    model: MODEL_NAME,
    hasFleetData: typeof fleetData === "string" ? fleetData.length > 0 : hasFleetData(fleetData),
    hasFleetConfig: !!fleetConfig,
    hasDockBriefing: !!dockBriefing,
    hasMicroRunner: !!microRunner,
    promptLen: buildSystemPrompt(fleetData, fleetConfig, dockBriefing).length,
  }, "init");

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
      log.gemini.debug({ sessionId, totalSessions: sessions.size }, "session:create");
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
      log.gemini.debug({ cleaned, remaining: sessions.size }, "session:cleanup");
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
      log.gemini.debug({ sessionId, messageLen: message.length, historyLen: session.history.length }, "chat:send");

      // Always store the original user message in history
      session.history.push({ role: "user", text: message });

      // ── MicroRunner pipeline (optional) ──────────────────
      if (microRunner) {
        const startTime = Date.now();
        const { contract, gatedContext, augmentedMessage } = microRunner.prepare(message);

        // Send augmented message (with gated context prepended)
        const result = await session.chatSession.sendMessage(augmentedMessage);
        let responseText = result.response.text();

        // Validate response against contract
        const validation = microRunner.validate(
          responseText, contract, gatedContext, sessionId, startTime,
        );
        let receipt = validation.receipt;

        // Single repair pass if validation failed
        if (validation.needsRepair && validation.repairPrompt) {
          log.gemini.debug({ sessionId, violations: receipt.validationDetails }, "microrunner:repair");
          const repairResult = await session.chatSession.sendMessage(validation.repairPrompt);
          responseText = repairResult.response.text();
          receipt.repairAttempted = true;

          // Re-validate the repaired response
          const revalidation = microRunner.validate(
            responseText, contract, gatedContext, sessionId, startTime,
          );
          receipt.validationResult = revalidation.receipt.validationResult === "pass" ? "repaired" : "fail";
          receipt.validationDetails = revalidation.receipt.validationDetails;
          receipt.durationMs = Date.now() - startTime;

          // If still failing after repair, prepend disclaimer
          if (receipt.validationResult === "fail") {
            responseText = `${VALIDATION_DISCLAIMER}\n\n${responseText}`;
          }
        }

        microRunner.finalize(receipt);

        session.history.push({ role: "model", text: responseText });
        while (session.history.length > SESSION_MAX_TURNS * 2) {
          session.history.splice(0, 2);
        }
        log.gemini.debug({ sessionId, responseLen: responseText.length, historyLen: session.history.length }, "chat:recv");
        return responseText;
      }

      // ── Standard path (no MicroRunner) ────────────────────
      const result = await session.chatSession.sendMessage(message);
      const responseText = result.response.text();

      session.history.push({ role: "model", text: responseText });

      // Enforce turn limit: drop oldest pair if over max
      while (session.history.length > SESSION_MAX_TURNS * 2) {
        session.history.splice(0, 2);
      }

      log.gemini.debug({ sessionId, responseLen: responseText.length, historyLen: session.history.length }, "chat:recv");
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
        log.gemini.debug({ sessionId, remaining: sessions.size }, "session:close");
      }
    },
  };
}
