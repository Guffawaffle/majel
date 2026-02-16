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
  SchemaType,
  type ChatSession,
  type SafetySetting,
  type GenerativeModel,
  type Part,
  type FunctionCall,
} from "@google/generative-ai";
import { log } from "../logger.js";
import { type MicroRunner, VALIDATION_DISCLAIMER } from "./micro-runner.js";
import {
  type ToolContext,
  FLEET_TOOL_DECLARATIONS,
  executeFleetTool,
} from "./fleet-tools.js";

// ─── Model Registry ───────────────────────────────────────────

/**
 * Available Gemini models with metadata for the model selector.
 *
 * Ordered by cost tier (cheapest → most expensive).
 * Model IDs use stable version aliases unless preview-only.
 *
 * Pricing notes (per 1M tokens, as of Feb 2026):
 * - Flash-Lite:  $0.075 input / $0.30 output (cheapest, no native thinking)
 * - 2.5 Flash:   $0.15 input / $0.60 output (thinking-capable, great balance)
 * - 3 Flash:     ~$0.15 input / $0.60 output (latest gen, native thinking)
 * - 2.5 Pro:     $1.25 input / $10 output (deep reasoning, long context)
 * - 3 Pro:       ~$1.25 input / $10 output (frontier intelligence)
 */
export interface ModelDef {
  id: string;
  name: string;
  tier: "budget" | "balanced" | "thinking" | "premium" | "frontier";
  description: string;
  thinking: boolean;
  contextWindow: number;
  costRelative: number; // 1 = cheapest, 5 = most expensive
  speed: "fastest" | "fast" | "moderate" | "slow";
}

export const MODEL_REGISTRY: ModelDef[] = [
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash-Lite",
    tier: "budget",
    description: "Ultra-fast, lowest cost. Great for high-volume chat. No native thinking.",
    thinking: false,
    contextWindow: 1_048_576,
    costRelative: 1,
    speed: "fastest",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    tier: "balanced",
    description: "Best price-performance. Thinking-capable with dynamic budget. Solid all-rounder.",
    thinking: true,
    contextWindow: 1_048_576,
    costRelative: 2,
    speed: "fast",
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash (Preview)",
    tier: "thinking",
    description: "Latest-gen Flash with native thinking. Fast + smart. Preview — may change.",
    thinking: true,
    contextWindow: 1_048_576,
    costRelative: 2,
    speed: "fast",
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    tier: "premium",
    description: "Advanced reasoning, deep analysis, long context. Best for complex strategy & code.",
    thinking: true,
    contextWindow: 1_048_576,
    costRelative: 4,
    speed: "moderate",
  },
  {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro (Preview)",
    tier: "frontier",
    description: "Most intelligent model. State-of-the-art reasoning & multimodal. Preview — may change.",
    thinking: true,
    contextWindow: 1_048_576,
    costRelative: 5,
    speed: "slow",
  },
];

const MODEL_REGISTRY_MAP = new Map(MODEL_REGISTRY.map((m) => [m.id, m]));

/** Get a model definition by ID, or null if unknown. */
export function getModelDef(modelId: string): ModelDef | null {
  return MODEL_REGISTRY_MAP.get(modelId) ?? null;
}

/** Validate a model ID. Returns the ID if valid, or the default if not. */
export function resolveModelId(modelId: string | undefined | null): string {
  if (modelId && MODEL_REGISTRY_MAP.has(modelId)) return modelId;
  return MODEL_REGISTRY[0].id; // default: flash-lite
}

const DEFAULT_MODEL = "gemini-2.5-flash-lite";

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
 * 4. CONTEXT — reference catalog + overlay data injected via MicroRunner context gating
 * 5. Never restrict discussion topics — but never present uncertain knowledge as authoritative
 */
export function buildSystemPrompt(
  fleetConfig?: FleetConfig | null,
  dockBriefing?: string | null,
  hasTools?: boolean,
): string {

  // ── Layer 1: Identity ─────────────────────────────────────────
  let prompt = `You are Aria, the Fleet Intelligence System aboard Admiral Guff's flagship.
Your full designation is Ariadne — named in honor of Majel Barrett-Roddenberry (1932–2008), the voice of every Starfleet computer.

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
2. REFERENCE PACKS — Officer/ship reference catalogs from structured game data, if present below. Community-curated data with known provenance. Cite the source: "According to the imported reference data..."
3. TRAINING KNOWLEDGE — Your general knowledge from model training. You have SUBSTANTIAL knowledge about STFC — officer abilities, crew combos, ship tiers, the combat triangle, mining strategies, faction dynamics, PvP/PvE meta, and game mechanics. LEAD with this knowledge when asked. STFC is a live game so patch-sensitive specifics (exact stat numbers, costs, current event details) may be outdated — note this briefly at the end, not at the beginning. Signal when relevant: "This may have shifted with recent patches" / "Last I knew..."
4. INFERENCE — Conclusions you draw by combining sources. Always label: "Based on that, I'd suggest..."

The critical boundary: never present training knowledge as if it were injected data. If the Admiral asks for a specific number (a stat, a cost) and it's not in your context, give your best recollection and flag it as approximate rather than refusing entirely.

STFC EXPERTISE:
You know a LOT about Star Trek Fleet Command. When the Admiral asks about strategy, crews, ships, or game mechanics:
- LEAD with what you know. Give a real, actionable answer.
- DO NOT lead with "I don't have access to..." or "I cannot look up..." — that's a dead-end.
- DO NOT open with disclaimers. Share your knowledge first, then add a brief note about potential staleness at the end if relevant.
- You understand: the combat triangle (Explorer > Interceptor > Battleship > Explorer), officer synergies, crew combos for mining/PvP/hostiles, ship grades and tiers, faction dynamics, research trees, and event strategies.
- For meta questions like "What's the current PvP meta?": share what you know about strong crew combos and strategies, note your training cutoff, and suggest the Admiral check community resources for the latest shifts.

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
   - MODERATE (training knowledge, game mechanics): Share confidently, note potential staleness briefly at the end. "Kirk/Spock/Bones is the classic PvP crew for Explorers... this may have shifted with recent patches."
   - LOW (speculation, edge-of-knowledge): Be explicit. "I'm not certain, but..."
   - NO DATA: Offer what you can. "I don't have specific data on that, but here's what I know that might help..."

3. WHEN UNCERTAIN, DECOMPOSE — Separate what you know from what you don't: "Your roster shows Kirk at level 50 — that I can see. For the current PvP meta, I'd be relying on training data which may be outdated."

4. CORRECTIONS ARE WELCOME — If the Admiral corrects you, accept it. "Good catch, Admiral. Let me reconsider."

ARCHITECTURE (general description only):
You run on Google Gemini (model selectable by the Admiral). Your supporting systems include conversation memory (Lex), a settings store (PostgreSQL), a reference catalog (structured game data officers/ships), and a user overlay (ownership, targeting, levels).
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

  // ── Layer 3: Tool Use ──────────────────────────────────────
  if (hasTools) {
    prompt += `FLEET INTELLIGENCE TOOLS:
You have fleet intelligence tools available. USE THEM. Do not ask the Admiral for information you can look up.

TOOL-USE RULES:
1. LOOK IT UP, DON'T ASK — When the Admiral mentions a ship, officer, or activity, call the appropriate tool immediately. Do NOT ask "which ship?" or "what officers do you have?" — search for it.
2. CHAIN TOOLS — Complex requests need multiple calls. To suggest a crew: call search_ships (find the ship ID) → suggest_crew (get roster + context) → then recommend using your STFC knowledge.
3. PROACTIVE DATA GATHERING — When asked about crews, fleet state, or optimization:
   - Call get_fleet_overview for the big picture
   - Call list_owned_officers to see the Admiral's roster
   - Call list_docks to see current dock state
   - Call search_ships / search_officers to resolve names to IDs
   - Call suggest_crew with the ship_id + intent_key for crew recommendations
4. NAME RESOLUTION — The Admiral will use common names ("Saladin", "Kirk"). Call search_ships or search_officers to resolve these to reference IDs before passing them to other tools.
5. DON'T PARROT TOOL DATA — Synthesize results. The Admiral wants your analysis and recommendation, not a JSON dump.
6. INTENT KEYS — Common activity intents: grinding (hostile farming), pvp, mining-lat, mining-gas, mining-ore, mining-tri, mining-dil, mining-par, armada, base-defense, events. Use these with suggest_crew and find_loadouts_for_intent.
7. MUTATIONS — Tools like create_bridge_core, create_loadout, create_variant, and set_reservation modify the Admiral's data. Confirm intent before calling mutation tools. Read-only tools (search, list, suggest, analyze) are always safe to call.

TOOL SELECTION GUIDE:
- "What officers do I have?" → list_owned_officers
- "Tell me about Kirk" → search_officers("Kirk") → get_officer_detail(id)
- "Plan my grinding crews" → search_ships (find ship IDs) → suggest_crew (for each ship) → recommend
- "What's in my docks?" → list_docks or get_effective_state
- "Any conflicts?" → get_officer_conflicts or detect_target_conflicts
- "Optimize my fleet" → analyze_fleet
- "What should I work toward?" → suggest_targets
- "Create a crew for my Saladin" → search_ships("Saladin") → suggest_crew(ship_id, intent_key)

`;
  }

  // ── Layer 4: Reference catalog architecture note ────────────
  // Actual reference data + overlay context is injected per-message
  // by the MicroRunner's ContextGate, not in the system prompt.
  prompt += `FLEET INTELLIGENCE — REFERENCE CATALOG:
This installation uses a structured game data reference catalog with a user overlay model.
- The reference catalog contains canonical officer/ship data from community game data.
- The user's ownership state, targeting, and levels are stored as a thin overlay on catalog entries.
- When reference data or overlay state is available for a query, it will be injected into the conversation context by the MicroRunner pipeline. Look for labeled [REFERENCE] and [OVERLAY] blocks in user messages.
- If no reference data is injected, the catalog may not be populated yet. Guide the Admiral to sync reference data first.
`;

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
  /** Get the current model ID. */
  getModel(): string;
  /** Hot-swap the model. Clears all sessions (new model = fresh context). */
  setModel(modelId: string): void;
  /** Clean up resources (cleanup timer). Call on shutdown or in tests. */
  close(): void;
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
  fleetConfig?: FleetConfig | null,
  dockBriefing?: string | null,
  microRunner?: MicroRunner | null,
  initialModelId?: string | null,
  toolContext?: ToolContext | null,
): GeminiEngine {
  // I5: Fail fast with clear message if API key is missing
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required — cannot create Gemini engine without it");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  // Build tools array if tool context is available and has any stores
  const hasToolContext = toolContext &&
    (toolContext.referenceStore || toolContext.overlayStore || toolContext.crewStore);
  const systemInstruction = buildSystemPrompt(fleetConfig, dockBriefing, !!hasToolContext);

  let currentModelId = resolveModelId(initialModelId);

  const tools = hasToolContext
    ? [{ functionDeclarations: FLEET_TOOL_DECLARATIONS }]
    : undefined;

  function createModel(modelId: string): GenerativeModel {
    return genAI.getGenerativeModel({
      model: modelId,
      systemInstruction,
      safetySettings: SAFETY_SETTINGS,
      ...(tools ? { tools } : {}),
    });
  }

  let model = createModel(currentModelId);
  const sessions = new Map<string, SessionState>();

  /** Per-session mutex: prevents concurrent chat() calls from corrupting history */
  const sessionLocks = new Map<string, Promise<void>>();
  function withSessionLock(sessionId: string, fn: () => Promise<string>): Promise<string> {
    const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((r) => { release = r; });
    sessionLocks.set(sessionId, next);
    return prev.then(fn).finally(() => release());
  }

  log.gemini.debug({
    model: currentModelId,
    hasFleetConfig: !!fleetConfig,
    hasDockBriefing: !!dockBriefing,
    hasMicroRunner: !!microRunner,
    hasToolContext: !!hasToolContext,
    toolCount: hasToolContext ? FLEET_TOOL_DECLARATIONS.length : 0,
    promptLen: systemInstruction.length,
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

  /** Max rounds of function calling before forcing a text response */
  const MAX_TOOL_ROUNDS = 5;

  /**
   * Patterns that could be used for prompt injection via data-poisoned
   * tool responses (e.g., a malicious officer name containing instructions).
   * We sanitize these from all string values before feeding back to the model.
   */
  const INJECTION_PATTERNS = /\[(SYSTEM|CONTEXT|END CONTEXT|INSTRUCTION)[^\]]*\]|<\/?system>|<\/?instruction>/gi;
  const MAX_FIELD_LENGTH = 500;

  /** Deep-sanitize tool response objects before feeding them to the model */
  function sanitizeToolResponse(obj: unknown): unknown {
    if (typeof obj === "string") {
      let s = obj.replace(INJECTION_PATTERNS, "");
      if (s.length > MAX_FIELD_LENGTH) s = s.slice(0, MAX_FIELD_LENGTH) + "…";
      return s;
    }
    if (Array.isArray(obj)) return obj.map(sanitizeToolResponse);
    if (obj && typeof obj === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        out[k] = sanitizeToolResponse(v);
      }
      return out;
    }
    return obj; // numbers, booleans, null
  }

  /**
   * Handle the function call loop: execute tool calls, send responses back,
   * repeat until Gemini produces a text response.
   *
   * Returns the final text response from the model.
   */
  const MUTATION_TOOLS = new Set([
    "create_bridge_core", "create_loadout", "create_variant",
    "set_reservation", "activate_preset",
  ]);
  const MAX_MUTATIONS_PER_CHAT = 5;

  async function handleFunctionCalls(
    chatSession: ChatSession,
    initialFunctionCalls: FunctionCall[],
    sessionId: string,
  ): Promise<string> {
    let functionCalls = initialFunctionCalls;
    let round = 0;
    let mutationCount = 0;

    while (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      round++;
      log.gemini.debug({
        sessionId,
        round,
        calls: functionCalls.map((fc) => fc.name),
      }, "tool:round");

      // Execute all function calls in parallel
      const responses = await Promise.all(
        functionCalls.map(async (fc) => {
          // Enforce mutation budget per chat turn
          if (MUTATION_TOOLS.has(fc.name)) {
            mutationCount++;
            if (mutationCount > MAX_MUTATIONS_PER_CHAT) {
              return {
                functionResponse: {
                  name: fc.name,
                  response: { error: "Mutation limit reached for this message. Ask the Admiral to confirm before proceeding." },
                },
              } as Part;
            }
          }
          const result = await executeFleetTool(
            fc.name,
            fc.args as Record<string, unknown>,
            toolContext!,
          );
          return {
            functionResponse: {
              name: fc.name,
              response: sanitizeToolResponse(result),
            },
          } as Part;
        }),
      );

      // Send function responses back to the model
      const result = await chatSession.sendMessage(responses);
      const nextCalls = result.response.functionCalls();

      if (nextCalls && nextCalls.length > 0) {
        functionCalls = nextCalls;
        continue;
      }

      // Model produced a text response — we're done
      return result.response.text();
    }

    // Safety: max rounds exceeded — force a text response
    if (round >= MAX_TOOL_ROUNDS) {
      log.gemini.warn({ sessionId, rounds: round }, "tool:max-rounds");
    }

    // If we get here with no text, ask the model to summarize
    const summaryResult = await chatSession.sendMessage(
      "Please provide a text response summarizing the tool results.",
    );
    return summaryResult.response.text();
  }

  return {
    async chat(message: string, sessionId = "default"): Promise<string> {
      return withSessionLock(sessionId, async () => {
      const session = getSession(sessionId);
      log.gemini.debug({ sessionId, messageLen: message.length, historyLen: session.history.length }, "chat:send");

      // ── MicroRunner pipeline (optional) ──────────────────
      if (microRunner) {
        const startTime = Date.now();
        const { contract, gatedContext, augmentedMessage } = await microRunner.prepare(message);

        // Send augmented message (with gated context prepended)
        const result = await session.chatSession.sendMessage(augmentedMessage);

        // Check for function calls before text extraction
        let responseText: string;
        const functionCalls = hasToolContext ? result.response.functionCalls() : undefined;

        if (functionCalls && functionCalls.length > 0) {
          // Handle function call loop — tool results feed back to model
          responseText = await handleFunctionCalls(session.chatSession, functionCalls, sessionId);
        } else {
          responseText = result.response.text();
        }

        // Validate response against contract
        const validation = await microRunner.validate(
          responseText, contract, gatedContext, sessionId, startTime, message,
        );
        const receipt = validation.receipt;

        // Single repair pass if validation failed
        if (validation.needsRepair && validation.repairPrompt) {
          log.gemini.debug({ sessionId, violations: receipt.validationDetails }, "microrunner:repair");
          const repairResult = await session.chatSession.sendMessage(validation.repairPrompt);
          responseText = repairResult.response.text();
          receipt.repairAttempted = true;

          // Re-validate the repaired response
          const revalidation = await microRunner.validate(
            responseText, contract, gatedContext, sessionId, startTime, message,
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

        session.history.push({ role: "user", text: message });
        session.history.push({ role: "model", text: responseText });
        while (session.history.length > SESSION_MAX_TURNS * 2) {
          session.history.splice(0, 2);
        }
        log.gemini.debug({ sessionId, responseLen: responseText.length, historyLen: session.history.length }, "chat:recv");
        return responseText;
      }

      // ── Standard path (no MicroRunner) ────────────────────
      const result = await session.chatSession.sendMessage(message);

      // Check for function calls before text extraction
      let responseText: string;
      const functionCalls = hasToolContext ? result.response.functionCalls() : undefined;

      if (functionCalls && functionCalls.length > 0) {
        responseText = await handleFunctionCalls(session.chatSession, functionCalls, sessionId);
      } else {
        responseText = result.response.text();
      }

      session.history.push({ role: "user", text: message });
      session.history.push({ role: "model", text: responseText });

      // Enforce turn limit: drop oldest pair if over max
      while (session.history.length > SESSION_MAX_TURNS * 2) {
        session.history.splice(0, 2);
      }

      log.gemini.debug({ sessionId, responseLen: responseText.length, historyLen: session.history.length }, "chat:recv");
      return responseText;
      }); // end withSessionLock
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

    getModel(): string {
      return currentModelId;
    },

    setModel(modelId: string): void {
      // I6: Throw on unrecognized model instead of silently degrading
      if (!MODEL_REGISTRY_MAP.has(modelId)) {
        throw new Error(`Unknown model: ${modelId}. Valid: ${MODEL_REGISTRY.map((m) => m.id).join(", ")}`);
      }
      if (modelId === currentModelId) return;

      const previousModel = currentModelId;
      currentModelId = modelId;
      model = createModel(modelId);

      // Clear all sessions — new model needs fresh chat context
      const sessionCount = sessions.size;
      sessions.clear();

      log.gemini.info({
        previousModel,
        newModel: modelId,
        sessionsCleared: sessionCount,
      }, "model:switch");
    },

    close(): void {
      // M2: Clear cleanup timer to prevent leaks in tests
      if (cleanupTimer) clearInterval(cleanupTimer);
      sessions.clear();
      log.gemini.debug("engine:close");
    },
  };
}
