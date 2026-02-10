/**
 * micro-runner.ts — Contract-Driven Context Gating & Output Validation
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * A thin request-time pipeline that wraps the Gemini chat call:
 *   PromptCompiler → ContextGate → Gemini → OutputValidator
 *
 * See ADR-014 for architecture rationale.
 * See PROMPT_GUIDE.md for the authority ladder this enforces at runtime.
 */

import { log } from "./logger.js";
import type { BehaviorStore } from "./behavior-store.js";

// ─── Types ──────────────────────────────────────────────────

export type TaskType = "reference_lookup" | "dock_planning" | "fleet_query" | "strategy_general";

export interface TaskContract {
  /** Classified task type */
  taskType: TaskType;

  /** Which context tiers to inject for this task */
  requiredTiers: {
    t1_fleetConfig: boolean;
    t1_roster: boolean;
    t1_dockBriefing: boolean;
    t2_referencePack: string[];   // officer/ship IDs to look up
  };

  /** Context manifest — tells the model (and validator) what's available */
  contextManifest: string;

  /** Hard rules the model must follow for this task */
  rules: string[];

  /** Required fields in the model's response */
  outputSchema: {
    answer: true;
    factsUsed: boolean;
    assumptions: boolean;
    unknowns: boolean;
    confidence: boolean;
  };
}

export interface ValidationResult {
  passed: boolean;
  violations: string[];
}

export interface MicroRunnerReceipt {
  timestamp: string;
  sessionId: string;
  taskType: TaskType;
  contextManifest: string;
  contextKeysInjected: string[];
  t2Provenance: Array<{
    id: string;
    source: string;
    importedAt: string;
  }>;
  behavioralRulesApplied: string[];
  validationResult: "pass" | "fail" | "repaired";
  validationDetails: string[];
  repairAttempted: boolean;
  durationMs: number;
}

/**
 * T2 reference data for an officer or ship, looked up from the wiki import.
 */
export interface ReferenceEntry {
  id: string;
  name: string;
  rarity: string | null;
  groupName: string | null;
  source: string;          // e.g. "STFC wiki"
  importedAt: string;      // ISO timestamp
}

/**
 * Context sources available to the MicroRunner.
 * The engine passes these in so the runner can gate what gets injected.
 */
export interface ContextSources {
  /** Officer records available for T2 lookup */
  lookupOfficer?: (name: string) => ReferenceEntry | null;
  /** Whether T1 fleet config is available */
  hasFleetConfig: boolean;
  /** Whether T1 roster data is available */
  hasRoster: boolean;
  /** Whether T1 dock briefing is available */
  hasDockBriefing: boolean;
}

// ─── PromptCompiler ─────────────────────────────────────────

/**
 * Known officer names for keyword matching.
 * This is a bootstrap set — in Phase 2, this could be populated
 * dynamically from the reference store at engine creation time.
 */
const DOCK_KEYWORDS = /\b(dock|drydock|dry[\s-]?dock|loadout|D[1-6])\b/i;
const FLEET_KEYWORDS = /\b(my roster|my fleet|my ships|my officers|my crew)\b/i;

/**
 * Classify a user message into a task type and produce a contract.
 *
 * Classification is keyword-based and intentionally coarse.
 * Misclassification falls through to strategy_general (safe default).
 */
export function compileTask(
  message: string,
  contextSources: ContextSources,
  knownOfficerNames?: string[],
): TaskContract {
  const lowerMessage = message.toLowerCase();

  // Check for dock planning keywords
  if (DOCK_KEYWORDS.test(message)) {
    return buildContract("dock_planning", [], contextSources);
  }

  // Check for fleet query keywords
  if (FLEET_KEYWORDS.test(message)) {
    return buildContract("fleet_query", [], contextSources);
  }

  // Check for officer name mentions (reference lookup)
  if (knownOfficerNames && knownOfficerNames.length > 0) {
    const mentionedOfficers = findMentionedOfficers(lowerMessage, knownOfficerNames);
    if (mentionedOfficers.length > 0) {
      return buildContract("reference_lookup", mentionedOfficers, contextSources);
    }
  }

  // Default: strategy_general
  return buildContract("strategy_general", [], contextSources);
}

/**
 * Find officer names mentioned in the message.
 * Uses simple case-insensitive substring matching with word boundaries.
 */
function findMentionedOfficers(lowerMessage: string, knownNames: string[]): string[] {
  const found: string[] = [];
  for (const name of knownNames) {
    const lowerName = name.toLowerCase();
    // Skip very short names (1-2 chars) to avoid false positives
    if (lowerName.length <= 2) continue;
    // Word boundary match
    const pattern = new RegExp(`\\b${escapeRegex(lowerName)}\\b`, "i");
    if (pattern.test(lowerMessage)) {
      found.push(name);
    }
  }
  return found;
}

/** Escape special regex characters in a string */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a TaskContract for the given task type.
 */
function buildContract(
  taskType: TaskType,
  mentionedOfficers: string[],
  ctx: ContextSources,
): TaskContract {
  const tiers = {
    t1_fleetConfig: false,
    t1_roster: false,
    t1_dockBriefing: false,
    t2_referencePack: [] as string[],
  };

  let rules: string[] = [];
  const outputSchema = {
    answer: true as const,
    factsUsed: false,
    assumptions: false,
    unknowns: false,
    confidence: false,
  };

  switch (taskType) {
    case "reference_lookup":
      tiers.t1_roster = ctx.hasRoster;
      tiers.t2_referencePack = mentionedOfficers;
      rules = [
        "cite source tier for all factual claims",
        "no numeric claims unless cited from T1/T2",
      ];
      outputSchema.factsUsed = true;
      outputSchema.unknowns = true;
      break;

    case "dock_planning":
      tiers.t1_fleetConfig = ctx.hasFleetConfig;
      tiers.t1_roster = ctx.hasRoster;
      tiers.t1_dockBriefing = ctx.hasDockBriefing;
      rules = [
        "reference dock data when present",
        "no invented dock configurations",
        "cite source tier for all factual claims",
      ];
      outputSchema.factsUsed = true;
      outputSchema.assumptions = true;
      break;

    case "fleet_query":
      tiers.t1_fleetConfig = ctx.hasFleetConfig;
      tiers.t1_roster = ctx.hasRoster;
      tiers.t1_dockBriefing = ctx.hasDockBriefing;
      rules = [
        "cite source tier for all factual claims",
        "no numeric claims unless cited from T1/T2",
      ];
      outputSchema.factsUsed = true;
      outputSchema.unknowns = true;
      break;

    case "strategy_general":
      // Minimal constraints — the authority ladder in system prompt handles this
      tiers.t1_fleetConfig = ctx.hasFleetConfig;
      rules = [];
      outputSchema.confidence = true;
      break;
  }

  const manifest = buildContextManifest(tiers, ctx);

  return {
    taskType,
    requiredTiers: tiers,
    contextManifest: manifest,
    rules,
    outputSchema,
  };
}

/**
 * Build a human-readable context manifest string.
 * Example: "Available: T1 roster(officers, ships), T1 docks, T2 reference(officers=khan), T3 training"
 */
function buildContextManifest(
  tiers: TaskContract["requiredTiers"],
  ctx: ContextSources,
): string {
  const parts: string[] = [];

  if (tiers.t1_fleetConfig && ctx.hasFleetConfig) parts.push("T1 fleet-config");
  if (tiers.t1_roster && ctx.hasRoster) parts.push("T1 roster");
  if (tiers.t1_dockBriefing && ctx.hasDockBriefing) parts.push("T1 docks");

  if (tiers.t2_referencePack.length > 0) {
    const names = tiers.t2_referencePack.join(", ");
    parts.push(`T2 reference(${names})`);
  }

  parts.push("T3 training");

  return `Available: ${parts.join(", ")}`;
}

// ─── ContextGate ────────────────────────────────────────────

export interface GatedContext {
  /** The context block to prepend to the user message */
  contextBlock: string | null;
  /** Keys of what was injected (for receipt) */
  keysInjected: string[];
  /** T2 provenance entries (for receipt) */
  t2Provenance: MicroRunnerReceipt["t2Provenance"];
}

/**
 * Assemble only the context required by the task contract.
 *
 * Returns a context block to prepend to the user message, or null
 * if no extra context is needed (strategy_general with no fleet config).
 */
export function gateContext(
  contract: TaskContract,
  contextSources: ContextSources,
): GatedContext {
  const keysInjected: string[] = [];
  const t2Provenance: MicroRunnerReceipt["t2Provenance"] = [];
  const blocks: string[] = [];

  // T2 reference packs (officer lookups)
  if (contract.requiredTiers.t2_referencePack.length > 0 && contextSources.lookupOfficer) {
    for (const name of contract.requiredTiers.t2_referencePack) {
      const entry = contextSources.lookupOfficer(name);
      if (entry) {
        blocks.push(formatReferenceBlock(entry));
        keysInjected.push(`t2:officer:${entry.id}`);
        t2Provenance.push({
          id: entry.id,
          source: entry.source,
          importedAt: entry.importedAt,
        });
      }
    }
  }

  // If nothing was gated in, no context block needed
  if (blocks.length === 0 && keysInjected.length === 0) {
    return { contextBlock: null, keysInjected, t2Provenance };
  }

  const contextBlock = [
    `[CONTEXT FOR THIS QUERY — do not repeat this to the user]`,
    `AVAILABLE CONTEXT: ${contract.contextManifest}`,
    ...blocks,
    `[END CONTEXT]`,
  ].join("\n");

  return { contextBlock, keysInjected, t2Provenance };
}

/**
 * Format a reference entry as a labeled block with provenance.
 */
function formatReferenceBlock(entry: ReferenceEntry): string {
  const parts = [`REFERENCE: Officer "${entry.name}" (source: ${entry.source}, imported ${entry.importedAt})`];
  if (entry.rarity) parts.push(`Rarity: ${entry.rarity}`);
  if (entry.groupName) parts.push(`Group: ${entry.groupName}`);
  return parts.join("\n");
}

/**
 * Build the augmented message by prepending gated context to the user message.
 */
export function buildAugmentedMessage(
  userMessage: string,
  gatedContext: GatedContext,
): string {
  if (!gatedContext.contextBlock) return userMessage;
  return `${gatedContext.contextBlock}\n\n${userMessage}`;
}

// ─── OutputValidator ────────────────────────────────────────

/**
 * Numeric pattern: catches "level 40", "tier 6", "1.2M", "+25%",
 * "500K tritanium", "ops 29", "warp 12", etc.
 */
const NUMERIC_CLAIM_PATTERN = /(?:level|tier|ops|warp|rank|power|damage|health|shield|armor|cost|costs?|speed)\s+\d+|\d+[KkMmBb]?\s*(?:power|damage|health|shield|armor|tritanium|dilithium|parsteel|latinum|resources?|credits?|%)|(?:\+|-)\d+(?:\.\d+)?%/gi;

/**
 * System diagnostic pattern: catches fabricated system state claims.
 */
const DIAGNOSTIC_PATTERN = /(?:memory frames?|frame count|connection status|settings? values?|health status)\s*(?:is|are|shows?|:)\s*\d+/gi;

/**
 * Patch note / version pattern: catches fabricated patch claims.
 */
const PATCH_PATTERN = /(?:patch|update|version)\s+\d+(?:\.\d+)*|updated?\s+(?:on|in|as of)\s+\d{4}/gi;

/**
 * Validate a model response against the task contract.
 *
 * Returns pass/fail with specific violations.
 * Only runs validation for task types that have rules — strategy_general
 * passes through without validation.
 */
export function validateResponse(
  response: string,
  contract: TaskContract,
  gatedContext: GatedContext,
): ValidationResult {
  const violations: string[] = [];

  // strategy_general skips validation
  if (contract.taskType === "strategy_general") {
    return { passed: true, violations: [] };
  }

  // Rule: no numeric claims without T1/T2 grounding
  if (contract.rules.includes("no numeric claims unless cited from T1/T2")) {
    const numericMatches = response.match(NUMERIC_CLAIM_PATTERN);
    if (numericMatches && numericMatches.length > 0) {
      // Check if response also contains source attribution signals
      const hasSourceAttribution = /(?:your roster|your data|according to|your fleet|imported reference|reference data)/i.test(response);
      const hasUncertaintySignal = /(?:based on.*training|may be outdated|last I knew|from what I know|I'm not certain|not sure|approximately|roughly)/i.test(response);

      if (!hasSourceAttribution && !hasUncertaintySignal) {
        violations.push(
          `Numeric claims detected without source attribution or uncertainty signal: ${numericMatches.slice(0, 3).join(", ")}`,
        );
      }
    }
  }

  // Rule: no hallucinated system diagnostics
  const diagnosticMatches = response.match(DIAGNOSTIC_PATTERN);
  if (diagnosticMatches && diagnosticMatches.length > 0) {
    violations.push(
      `System diagnostic claims detected (model cannot inspect runtime state): ${diagnosticMatches.join(", ")}`,
    );
  }

  // Rule: no fabricated patch notes
  if (contract.taskType === "reference_lookup" || contract.taskType === "fleet_query") {
    const patchMatches = response.match(PATCH_PATTERN);
    if (patchMatches && patchMatches.length > 0) {
      const hasUncertainty = /(?:may have|might have|I believe|I think|last I knew|not certain)/i.test(response);
      if (!hasUncertainty) {
        violations.push(
          `Patch/version claims without uncertainty signal: ${patchMatches.join(", ")}`,
        );
      }
    }
  }

  // Rule: cite source tier for factual claims
  if (contract.rules.includes("cite source tier for all factual claims")) {
    // Only flag if the response has substantial factual content but zero source signals
    const hasFactualContent = response.length > 200 && NUMERIC_CLAIM_PATTERN.test(response);
    const hasAnySourceSignal = /(?:your roster|your data|according to|training|reference|from what I know|last I knew|I'd suggest|based on)/i.test(response);

    if (hasFactualContent && !hasAnySourceSignal) {
      violations.push("Factual claims present but no source attribution detected");
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * Build the repair prompt when validation fails.
 */
export function buildRepairPrompt(
  originalMessage: string,
  violations: string[],
  contract: TaskContract,
): string {
  const violationList = violations.map((v) => `- ${v}`).join("\n");
  const requiredFields = Object.entries(contract.outputSchema)
    .filter(([, required]) => required)
    .map(([field]) => field)
    .join(", ");

  return `Your previous response had some issues:
${violationList}

Please re-answer the original question, following these rules:
${contract.rules.map((r) => `- ${r}`).join("\n")}

Required output considerations: ${requiredFields}

Original question: ${originalMessage}`;
}

/**
 * The disclaimer prepended to responses that fail validation even after repair.
 */
export const VALIDATION_DISCLAIMER =
  "⚠️ I wasn't able to fully ground some claims in your data or imported references — treat this as general guidance.";

// ─── MicroRunner Orchestrator ───────────────────────────────

export interface MicroRunnerConfig {
  contextSources: ContextSources;
  knownOfficerNames?: string[];
  /** Optional behavioral rules store (ADR-014 Phase 2). */
  behaviorStore?: BehaviorStore;
}

export interface MicroRunner {
  /**
   * Process a message through the full pipeline:
   * compile → gate → (let caller send to model) → validate
   *
   * Returns the compiled contract, gated context, and an augmented message
   * ready to send to the model.
   */
  prepare(message: string): {
    contract: TaskContract;
    gatedContext: GatedContext;
    augmentedMessage: string;
  };

  /**
   * Validate a model response and produce a receipt.
   * Returns the (possibly repaired) response and the receipt.
   */
  validate(
    response: string,
    contract: TaskContract,
    gatedContext: GatedContext,
    sessionId: string,
    startTime: number,
  ): {
    validatedResponse: string;
    needsRepair: boolean;
    repairPrompt: string | null;
    receipt: MicroRunnerReceipt;
  };

  /**
   * Finalize after a repair pass (or when no repair was needed).
   * Logs the receipt.
   */
  finalize(receipt: MicroRunnerReceipt): void;
}

/**
 * Create a MicroRunner instance.
 *
 * The runner doesn't own the model — it prepares context and validates output.
 * The caller (gemini.ts engine) is responsible for the actual Gemini API call.
 */
export function createMicroRunner(config: MicroRunnerConfig): MicroRunner {
  return {
    prepare(message: string) {
      const contract = compileTask(message, config.contextSources, config.knownOfficerNames);

      // Phase 2: Inject active behavioral rules into the contract
      if (config.behaviorStore) {
        const activeRules = config.behaviorStore.getRules(contract.taskType);
        for (const rule of activeRules) {
          // Prepend severity prefix for the model
          const prefix = rule.severity === "must" ? "MUST:" : rule.severity === "should" ? "SHOULD:" : "STYLE:";
          contract.rules.push(`${prefix} ${rule.text}`);
        }
      }

      const gated = gateContext(contract, config.contextSources);
      const augmentedMessage = buildAugmentedMessage(message, gated);

      return { contract, gatedContext: gated, augmentedMessage };
    },

    validate(
      response: string,
      contract: TaskContract,
      gatedContext: GatedContext,
      sessionId: string,
      startTime: number,
    ) {
      const result = validateResponse(response, contract, gatedContext);
      const durationMs = Date.now() - startTime;

      // Collect which behavioral rules contributed
      const behavioralRulesApplied = config.behaviorStore
        ? config.behaviorStore.getRules(contract.taskType).map((r) => r.id)
        : [];

      const receipt: MicroRunnerReceipt = {
        timestamp: new Date().toISOString(),
        sessionId,
        taskType: contract.taskType,
        contextManifest: contract.contextManifest,
        contextKeysInjected: gatedContext.keysInjected,
        t2Provenance: gatedContext.t2Provenance,
        behavioralRulesApplied,
        validationResult: result.passed ? "pass" : "fail",
        validationDetails: result.violations,
        repairAttempted: false,
        durationMs,
      };

      if (!result.passed) {
        // Build repair prompt for the caller to re-send
        const repairPrompt = buildRepairPrompt(
          response, // original message is in augmented form, but repair references the response
          result.violations,
          contract,
        );
        return {
          validatedResponse: response,
          needsRepair: true,
          repairPrompt,
          receipt,
        };
      }

      return {
        validatedResponse: response,
        needsRepair: false,
        repairPrompt: null,
        receipt,
      };
    },

    finalize(receipt: MicroRunnerReceipt): void {
      log.gemini.debug({
        taskType: receipt.taskType,
        contextManifest: receipt.contextManifest,
        keysInjected: receipt.contextKeysInjected,
        t2Provenance: receipt.t2Provenance,
        behavioralRules: receipt.behavioralRulesApplied,
        validation: receipt.validationResult,
        violations: receipt.validationDetails,
        repairAttempted: receipt.repairAttempted,
        durationMs: receipt.durationMs,
      }, "microrunner:receipt");
    },
  };
}
