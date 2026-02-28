/**
 * fleet-tools/mutate-tools.ts — Mutation Tool Implementations
 *
 * Majel — STFC Fleet Intelligence System
 *
 * ADR-025 mutation tools. These modify fleet state (bridge cores, loadouts,
 * presets, reservations, variants). Some require explicit user confirmation
 * via guided actions.
 *
 * AX design principles:
 * - Every response includes `tool` name for context in multi-turn loops
 * - Success responses include `nextSteps` hints so the model knows what to do next
 * - Error responses echo the invalid `input` so the model can self-correct
 * - Consistent shape: { tool, ...result } on success, { tool, error, input? } on failure
 */

import type { BridgeSlot, VariantPatch } from "../../types/crew-types.js";
import type { ToolContext } from "./declarations.js";
import type { TargetStatus, TargetType, UpdateTargetInput } from "../../stores/target-store.js";
import { VALID_TARGET_TYPES, VALID_TARGET_STATUSES } from "../../stores/target-store.js";
import type { OwnershipState, SetShipOverlayInput, SetOfficerOverlayInput } from "../../stores/overlay-store.js";
import { VALID_OWNERSHIP_STATES } from "../../stores/overlay-store.js";
import type {
  ResearchBuff,
  ResearchNodeInput,
  ResearchStateInput,
  ReplaceResearchSnapshotInput,
} from "../../stores/research-store.js";
import {
  parseMajelGameExport,
  normalizeOfficerRefId,
  normalizeShipRefId,
  ownershipFromOwnedFlag,
  syncOverlaySourceType,
  parseExportDate,
  manualUpdateTexts,
  parseExceptionNames,
  isExcludedName,
  inferOfficerLevelFromMaxRank,
  type MajelGameExport,
  type SyncOverlayOfficerInput,
  type SyncOverlayShipInput,
} from "./mutate-tools-import-helpers.js";

// ─── Helpers ────────────────────────────────────────────────

/** Max length for user-provided name/notes fields. */
const MAX_NAME_LEN = 120;
const MAX_NOTES_LEN = 500;

/** Safely extract and trim a string arg; returns "" if absent. */
function str(args: Record<string, unknown>, key: string): string {
  return String(args[key] ?? "").trim();
}

/** Validate and truncate a name field. Returns the cleaned name or an error string. */
function validName(raw: string, label: string): string | { error: string } {
  if (!raw) return { error: `${label} is required.` };
  if (raw.length > MAX_NAME_LEN)
    return { error: `${label} must be ${MAX_NAME_LEN} characters or fewer (got ${raw.length}).` };
  return raw;
}

/** Validate and truncate optional notes. */
function validNotes(args: Record<string, unknown>): string | undefined {
  const raw = str(args, "notes");
  if (!raw) return undefined;
  return raw.slice(0, MAX_NOTES_LEN);
}

async function parseManualOverlayUpdates(
  updates: string[],
  ctx: ToolContext,
  warnings: string[],
): Promise<{ officers: SyncOverlayOfficerInput[]; ships: SyncOverlayShipInput[] }> {
  const officers: SyncOverlayOfficerInput[] = [];
  const ships: SyncOverlayShipInput[] = [];

  if (updates.length === 0) {
    return { officers, ships };
  }
  if (!ctx.referenceStore) {
    warnings.push("manual_updates provided but reference store is unavailable; could not resolve entities.");
    return { officers, ships };
  }

  for (const update of updates) {
    const shipBulkMatch = update.match(
      /(?:^|\b)all\s+(?:of\s+my\s+|my\s+)?ships(?:\s+except\s+(.+?))?\s+are\s+max\s+(?:tier(?:\s+and\s+level)?|level\s+and\s+tier)(?:\b.*)?$/i,
    );
    if (shipBulkMatch) {
      const excludedNames = parseExceptionNames(shipBulkMatch[1]);
      const allShips = await ctx.referenceStore.listShips();
      let includedCount = 0;

      for (const ship of allShips) {
        if (isExcludedName(ship.name, excludedNames)) continue;

        const next: SyncOverlayShipInput = {
          refId: ship.id,
          owned: true,
        };
        if (ship.maxTier != null) next.tier = ship.maxTier;
        if (ship.maxLevel != null) next.level = ship.maxLevel;
        ships.push(next);
        includedCount++;
      }

      if (includedCount === 0) {
        warnings.push(`Manual update '${update}' did not match any ships after exclusions.`);
      }
      continue;
    }

    const officerBulkMatch = update.match(
      /(?:^|\b)all\s+(?:of\s+my\s+|my\s+)?officers(?:\s+except\s+(.+?))?\s+are\s+max\s+(?:rank(?:\s+and\s+level)?|level\s+and\s+rank)\.?$/i,
    );
    if (officerBulkMatch) {
      const excludedNames = parseExceptionNames(officerBulkMatch[1]);
      const allOfficers = await ctx.referenceStore.listOfficers();
      let includedCount = 0;

      for (const officer of allOfficers) {
        if (isExcludedName(officer.name, excludedNames)) continue;

        const inferredLevel = inferOfficerLevelFromMaxRank(officer.maxRank);
        const next: SyncOverlayOfficerInput = {
          refId: officer.id,
          owned: true,
          rank: officer.maxRank == null ? undefined : String(officer.maxRank),
          level: inferredLevel,
        };

        if (officer.maxRank == null) {
          warnings.push(`Officer ${officer.name} missing max rank metadata; set as owned without max rank.`);
        }
        officers.push(next);
        includedCount++;
      }

      if (includedCount === 0) {
        warnings.push(`Manual update '${update}' did not match any officers after exclusions.`);
      }
      continue;
    }

    const match = update.match(/(?:i\s+just\s+)?(?:upgraded|set)\s+(?:my\s+)?(.+?)\s+to\s+(tier|level|rank)\s+(\d+)/i);
    if (!match) {
      warnings.push(`Could not parse manual update: '${update}'. Use format like 'upgraded Enterprise to tier 7'.`);
      continue;
    }

    const name = match[1].trim();
    const field = match[2].toLowerCase() as "tier" | "level" | "rank";
    const value = Number(match[3]);

    const [officerMatches, shipMatches] = await Promise.all([
      ctx.referenceStore.searchOfficers(name),
      ctx.referenceStore.searchShips(name),
    ]);

    const officer = officerMatches[0] ?? null;
    const ship = shipMatches[0] ?? null;
    if (officer && ship) {
      warnings.push(`Manual update '${update}' is ambiguous (matches officer and ship).`);
      continue;
    }
    if (!officer && !ship) {
      warnings.push(`Manual update '${update}' did not match a known officer or ship.`);
      continue;
    }

    if (officer) {
      const next: SyncOverlayOfficerInput = { refId: officer.id, owned: true };
      if (field === "level") next.level = value;
      else if (field === "rank") next.rank = String(value);
      else next.tier = value;
      officers.push(next);
      continue;
    }

    if (ship) {
      const next: SyncOverlayShipInput = { refId: ship.id, owned: true };
      if (field === "tier") next.tier = value;
      else if (field === "level") next.level = value;
      else {
        warnings.push(`Manual update '${update}' uses rank for a ship; supported ship fields are tier/level.`);
        continue;
      }
      ships.push(next);
    }
  }

  return { officers, ships };
}

function changedOfficerFields(
  existing: {
    ownershipState: OwnershipState;
    level: number | null;
    rank: string | null;
    power: number | null;
  } | null,
  patch: SetOfficerOverlayInput,
): string[] {
  if (!existing) {
    return Object.keys(patch).filter((key) => key !== "refId");
  }
  const changed: string[] = [];
  if (patch.ownershipState != null && patch.ownershipState !== existing.ownershipState) changed.push("ownershipState");
  if (patch.level !== undefined && patch.level !== existing.level) changed.push("level");
  if (patch.rank !== undefined && patch.rank !== existing.rank) changed.push("rank");
  if (patch.power !== undefined && patch.power !== existing.power) changed.push("power");
  return changed;
}

function changedShipFields(
  existing: {
    ownershipState: OwnershipState;
    tier: number | null;
    level: number | null;
    power: number | null;
  } | null,
  patch: SetShipOverlayInput,
): string[] {
  if (!existing) {
    return Object.keys(patch).filter((key) => key !== "refId");
  }
  const changed: string[] = [];
  if (patch.ownershipState != null && patch.ownershipState !== existing.ownershipState) changed.push("ownershipState");
  if (patch.tier !== undefined && patch.tier !== existing.tier) changed.push("tier");
  if (patch.level !== undefined && patch.level !== existing.level) changed.push("level");
  if (patch.power !== undefined && patch.power !== existing.power) changed.push("power");
  return changed;
}

interface ResearchNodeExport {
  node_id?: unknown;
  tree?: unknown;
  name?: unknown;
  max_level?: unknown;
  dependencies?: unknown;
  buffs?: unknown;
}

interface ResearchStateExport {
  node_id?: unknown;
  level?: unknown;
  completed?: unknown;
  updated_at?: unknown;
}

interface ResearchExport {
  schema_version?: unknown;
  captured_at?: unknown;
  source?: unknown;
  nodes?: unknown;
  state?: unknown;
}

function parseResearchExport(args: Record<string, unknown>): { data?: ReplaceResearchSnapshotInput; error?: string } {
  const directPayload = args.export;
  const stringPayload = args.payload_json;

  let rawData: unknown = directPayload;
  if (!rawData && typeof stringPayload === "string") {
    try {
      rawData = JSON.parse(stringPayload);
    } catch {
      return { error: "payload_json is not valid JSON." };
    }
  }

  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    return { error: "Provide a research export object in export or payload_json." };
  }

  const parsed = rawData as ResearchExport;
  if (parsed.schema_version !== "1.0") {
    return { error: "Unsupported schema_version. Expected '1.0'." };
  }
  if (!Array.isArray(parsed.nodes)) {
    return { error: "Research export nodes must be an array." };
  }
  if (!Array.isArray(parsed.state)) {
    return { error: "Research export state must be an array." };
  }

  const nodes: ResearchNodeInput[] = [];
  const state: ResearchStateInput[] = [];

  for (const nodeEntry of parsed.nodes as ResearchNodeExport[]) {
    const nodeId = typeof nodeEntry.node_id === "string" ? nodeEntry.node_id.trim() : "";
    const tree = typeof nodeEntry.tree === "string" ? nodeEntry.tree.trim() : "";
    const name = typeof nodeEntry.name === "string" ? nodeEntry.name.trim() : "";
    const maxLevel = Number(nodeEntry.max_level);

    if (!nodeId || !tree || !name || !Number.isInteger(maxLevel) || maxLevel < 1) {
      return { error: "Each node requires node_id, tree, name, and integer max_level >= 1." };
    }

    const dependencies = Array.isArray(nodeEntry.dependencies)
      ? nodeEntry.dependencies.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
      : [];

    const buffsRaw = Array.isArray(nodeEntry.buffs) ? nodeEntry.buffs : [];
    const buffs: ResearchBuff[] = [];
    for (const buff of buffsRaw) {
      if (!buff || typeof buff !== "object") {
        return { error: `Node ${nodeId} has invalid buff entry.` };
      }
      const entry = buff as Record<string, unknown>;
      const kind = entry.kind;
      const metric = entry.metric;
      const value = entry.value;
      const unit = entry.unit;
      if (
        typeof kind !== "string"
        || !["ship", "officer", "resource", "combat", "other"].includes(kind)
        || typeof metric !== "string"
        || !metric.trim()
        || typeof value !== "number"
        || typeof unit !== "string"
        || !["percent", "flat", "multiplier"].includes(unit)
      ) {
        return { error: `Node ${nodeId} has invalid buff fields.` };
      }
      buffs.push({
        kind: kind as ResearchBuff["kind"],
        metric: metric.trim(),
        value,
        unit: unit as ResearchBuff["unit"],
      });
    }

    nodes.push({
      nodeId,
      tree,
      name,
      maxLevel,
      dependencies,
      buffs,
    });
  }

  for (const stateEntry of parsed.state as ResearchStateExport[]) {
    const nodeId = typeof stateEntry.node_id === "string" ? stateEntry.node_id.trim() : "";
    const level = Number(stateEntry.level);
    if (!nodeId || !Number.isInteger(level) || level < 0) {
      return { error: "Each state entry requires node_id and integer level >= 0." };
    }

    state.push({
      nodeId,
      level,
      completed: stateEntry.completed === true,
      updatedAt: typeof stateEntry.updated_at === "string" ? stateEntry.updated_at : null,
    });
  }

  return {
    data: {
      source: typeof parsed.source === "string" ? parsed.source : null,
      capturedAt: typeof parsed.captured_at === "string" ? parsed.captured_at : null,
      nodes,
      state,
    },
  };
}

// ─── Mutation Tools ─────────────────────────────────────────

export async function createBridgeCoreTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "create_bridge_core", error: "Crew system not available." };
  }

  const name = validName(str(args, "name"), "Name");
  if (typeof name === "object") return { tool: "create_bridge_core", ...name };

  const captain = str(args, "captain");
  const bridge1 = str(args, "bridge_1");
  const bridge2 = str(args, "bridge_2");

  if (!captain || !bridge1 || !bridge2) {
    return {
      tool: "create_bridge_core",
      error: "All three bridge slots are required: captain, bridge_1, bridge_2.",
      input: { captain: captain || null, bridge_1: bridge1 || null, bridge_2: bridge2 || null },
    };
  }

  const notes = validNotes(args);
  const members: Array<{ officerId: string; slot: BridgeSlot }> = [
    { officerId: captain, slot: "captain" },
    { officerId: bridge1, slot: "bridge_1" },
    { officerId: bridge2, slot: "bridge_2" },
  ];

  // ─── Dupe detection (#81) ───────────────────────────────
  const existingCores = await ctx.crewStore.listBridgeCores();

  // Check name match
  const nameMatch = existingCores.find(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  if (nameMatch) {
    return {
      tool: "create_bridge_core",
      status: "duplicate_detected",
      existingId: nameMatch.id,
      existingName: nameMatch.name,
      existingMembers: nameMatch.members.map((m) => ({ officerId: m.officerId, slot: m.slot })),
      message: `A bridge core named "${nameMatch.name}" already exists (ID ${nameMatch.id}).`,
      nextSteps: [
        `Use the existing bridge core ID ${nameMatch.id} in create_loadout.`,
        "Choose a different name to create a new bridge core.",
      ],
    };
  }

  // Check member-set match (same 3 officers regardless of slot/name)
  const requestedOfficers = [captain, bridge1, bridge2].sort();
  const memberMatch = existingCores.find((c) => {
    const existing = c.members.map((m) => m.officerId).sort();
    return existing.length === 3 &&
      existing[0] === requestedOfficers[0] &&
      existing[1] === requestedOfficers[1] &&
      existing[2] === requestedOfficers[2];
  });
  if (memberMatch) {
    return {
      tool: "create_bridge_core",
      status: "duplicate_detected",
      existingId: memberMatch.id,
      existingName: memberMatch.name,
      existingMembers: memberMatch.members.map((m) => ({ officerId: m.officerId, slot: m.slot })),
      message: `A bridge core with the same three officers already exists: "${memberMatch.name}" (ID ${memberMatch.id}).`,
      nextSteps: [
        `Use the existing bridge core ID ${memberMatch.id} in create_loadout.`,
        "Create with a different officer combination if this isn't the right crew.",
      ],
    };
  }

  const core = await ctx.crewStore.createBridgeCore(name, members, notes);
  return {
    tool: "create_bridge_core",
    created: true,
    bridgeCore: {
      id: core.id,
      name: core.name,
      members: core.members.map((m) => ({ officerId: m.officerId, slot: m.slot })),
    },
    nextSteps: [
      "Use create_loadout to assign this bridge core to a ship loadout.",
      "Use get_officer_conflicts to verify no officers are double-booked.",
    ],
  };
}

export async function createLoadoutTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "create_loadout", error: "Crew system not available." };
  }

  const shipId = str(args, "ship_id");
  if (!shipId) return { tool: "create_loadout", error: "Ship ID is required.", input: { ship_id: null } };

  const name = validName(str(args, "name"), "Name");
  if (typeof name === "object") return { tool: "create_loadout", ...name };

  const fields: {
    shipId: string; name: string; bridgeCoreId?: number; belowDeckPolicyId?: number;
    intentKeys?: string[]; notes?: string;
  } = { shipId, name };

  if (args.bridge_core_id != null) fields.bridgeCoreId = Number(args.bridge_core_id);
  if (args.below_deck_policy_id != null) fields.belowDeckPolicyId = Number(args.below_deck_policy_id);
  if (Array.isArray(args.intent_keys)) {
    fields.intentKeys = (args.intent_keys as string[]).map((k) => String(k).trim()).filter(Boolean);
  }
  fields.notes = validNotes(args);

  // ─── Dupe detection (#81) ───────────────────────────────
  const existingLoadouts = await ctx.crewStore.listLoadouts({ shipId });
  const nameMatch = existingLoadouts.find(
    (l) => l.name.toLowerCase() === name.toLowerCase(),
  );
  if (nameMatch) {
    return {
      tool: "create_loadout",
      status: "duplicate_detected",
      existingId: nameMatch.id,
      existingName: nameMatch.name,
      existingShipId: nameMatch.shipId,
      message: `A loadout named "${nameMatch.name}" already exists for this ship (ID ${nameMatch.id}).`,
      nextSteps: [
        `Use the existing loadout ID ${nameMatch.id}.`,
        "Use create_variant to create an alternate configuration on the existing loadout.",
        "Choose a different name to create a new loadout.",
      ],
    };
  }

  const loadout = await ctx.crewStore.createLoadout(fields);
  return {
    tool: "create_loadout",
    created: true,
    loadout: {
      id: loadout.id,
      name: loadout.name,
      shipId: loadout.shipId,
    },
    nextSteps: [
      "Use list_plan_items or get_effective_state to see where this loadout fits.",
      "Use create_variant to create alternate crew configurations for this loadout.",
    ],
  };
}

export async function activatePresetTool(presetId: number, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "activate_preset", error: "Crew system not available." };
  }
  if (!presetId || isNaN(presetId)) {
    return { tool: "activate_preset", error: "Valid preset ID is required.", input: { preset_id: presetId } };
  }

  const preset = await ctx.crewStore.getFleetPreset(presetId);
  if (!preset) {
    return { tool: "activate_preset", error: `Fleet preset not found with ID ${presetId}.`, input: { preset_id: presetId } };
  }

  // Return a guided action instead of executing directly.
  // Fleet-wide mutations require explicit user confirmation in the UI.
  return {
    tool: "activate_preset",
    guidedAction: true,
    actionType: "activate_preset",
    presetId: preset.id,
    presetName: preset.name,
    slotCount: preset.slots.length,
    message:
      `To activate this preset (${preset.slots.length} dock slots), ` +
      "direct the Admiral to Plan → Fleet Presets tab → click Activate. " +
      "This is a fleet-wide change that deactivates all other presets.",
    uiPath: "/app#plan/presets",
  };
}

export async function setReservationTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "set_reservation", error: "Crew system not available." };
  }

  const officerId = str(args, "officer_id");
  if (!officerId) {
    return { tool: "set_reservation", error: "Officer ID is required.", input: { officer_id: null } };
  }

  const reservedFor = str(args, "reserved_for");

  // Clear reservation if reservedFor is empty
  if (!reservedFor) {
    const deleted = await ctx.crewStore.deleteReservation(officerId);
    return {
      tool: "set_reservation",
      action: "cleared",
      officerId,
      existed: deleted,
      nextSteps: deleted
        ? ["Officer is now available for any crew assignment."]
        : ["No reservation existed for this officer — no change needed."],
    };
  }

  const locked = args.locked === true;
  const notes = validNotes(args);

  const reservation = await ctx.crewStore.setReservation(officerId, reservedFor, locked, notes);
  return {
    tool: "set_reservation",
    action: "set",
    reservation: {
      officerId: reservation.officerId,
      reservedFor: reservation.reservedFor,
      locked: reservation.locked,
    },
    nextSteps: locked
      ? ["This officer is now hard-locked — the solver will skip them entirely."]
      : ["This is a soft reservation — the solver will warn but not block assignment."],
  };
}

export async function createVariantTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "create_variant", error: "Crew system not available." };
  }

  const loadoutId = Number(args.loadout_id);
  if (!loadoutId || isNaN(loadoutId)) {
    return { tool: "create_variant", error: "Valid loadout ID is required.", input: { loadout_id: args.loadout_id ?? null } };
  }

  const name = validName(str(args, "name"), "Name");
  if (typeof name === "object") return { tool: "create_variant", ...name };

  // Build variant patch from optional bridge overrides
  const patch: VariantPatch = {};
  const bridgeOverrides: Partial<Record<BridgeSlot, string>> = {};
  const captain = str(args, "captain");
  const bridge1 = str(args, "bridge_1");
  const bridge2 = str(args, "bridge_2");
  if (captain) bridgeOverrides.captain = captain;
  if (bridge1) bridgeOverrides.bridge_1 = bridge1;
  if (bridge2) bridgeOverrides.bridge_2 = bridge2;
  if (Object.keys(bridgeOverrides).length > 0) patch.bridge = bridgeOverrides;

  const notes = validNotes(args);

  // ─── Dupe detection (#81) ───────────────────────────────
  const existingVariants = await ctx.crewStore.listVariants(loadoutId);
  const nameMatch = existingVariants.find(
    (v) => v.name.toLowerCase() === name.toLowerCase(),
  );
  if (nameMatch) {
    return {
      tool: "create_variant",
      status: "duplicate_detected",
      existingId: nameMatch.id,
      existingName: nameMatch.name,
      existingBaseLoadoutId: nameMatch.baseLoadoutId,
      message: `A variant named "${nameMatch.name}" already exists on this loadout (ID ${nameMatch.id}).`,
      nextSteps: [
        `Use the existing variant ID ${nameMatch.id}.`,
        "Choose a different name to create a new variant.",
      ],
    };
  }

  const variant = await ctx.crewStore.createVariant(loadoutId, name, patch, notes);
  return {
    tool: "create_variant",
    created: true,
    variant: {
      id: variant.id,
      baseLoadoutId: variant.baseLoadoutId,
      name: variant.name,
      patch: variant.patch,
    },
    nextSteps: [
      "Use get_loadout_detail to see how this variant looks against the base loadout.",
      "Use get_officer_conflicts to check for double-booked officers.",
    ],
  };
}

export async function getEffectiveStateTool(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "get_effective_state", error: "Crew system not available." };
  }

  const [state, presets] = await Promise.all([
    ctx.crewStore.getEffectiveDockState(),
    ctx.crewStore.listFleetPresets(),
  ]);

  const activePreset = presets.find((p) => p.isActive);
  const occupiedDocks = state.docks.filter((d) => d.loadout != null).length;

  return {
    tool: "get_effective_state",
    summary: {
      totalDocks: state.docks.length,
      occupiedDocks,
      emptyDocks: state.docks.length - occupiedDocks,
      awayTeams: state.awayTeams.length,
      conflicts: state.conflicts.length,
    },
    activePreset: activePreset ? { id: activePreset.id, name: activePreset.name } : null,
    docks: state.docks.map((d) => ({
      dockNumber: d.dockNumber,
      source: d.source,
      intentKeys: d.intentKeys,
      variantPatch: d.variantPatch,
      loadout: d.loadout
        ? {
            loadoutId: d.loadout.loadoutId,
            name: d.loadout.name,
            shipId: d.loadout.shipId,
            bridge: d.loadout.bridge,
            belowDeckPolicy: d.loadout.belowDeckPolicy
              ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
              : null,
          }
        : null,
    })),
    awayTeams: state.awayTeams.map((a) => ({
      label: a.label,
      officers: a.officers,
      source: a.source,
    })),
    conflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.map((loc) => ({
        type: loc.type,
        entityName: loc.entityName,
        slot: loc.slot,
      })),
    })),
  };
}

export async function syncOverlayTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.overlayStore) {
    return { tool: "sync_overlay", error: "Overlay store not available." };
  }

  const parsed = parseMajelGameExport(args);
  if (parsed.error) {
    return { tool: "sync_overlay", error: parsed.error };
  }

  const payload = parsed.data as MajelGameExport;
  const dryRun = args.dry_run !== false;
  const warnings: string[] = [];

  const exportDate = parseExportDate(payload.exportDate);
  const importAgeDays = exportDate
    ? Math.floor((Date.now() - exportDate.getTime()) / (24 * 60 * 60 * 1000))
    : null;
  const staleThresholdDays = 7;
  const isStale = importAgeDays != null && importAgeDays > staleThresholdDays;
  if (payload.exportDate && !exportDate) {
    warnings.push("MajelGameExport.exportDate is not a valid timestamp.");
  }
  if (isStale && importAgeDays != null) {
    warnings.push(`Import appears stale (${importAgeDays} days old; threshold is ${staleThresholdDays} days).`);
  }

  const [officerOverlays, shipOverlays] = await Promise.all([
    ctx.overlayStore.listOfficerOverlays(),
    ctx.overlayStore.listShipOverlays(),
  ]);
  const officerMap = new Map(officerOverlays.map((row) => [row.refId, row]));
  const shipMap = new Map(shipOverlays.map((row) => [row.refId, row]));

  const manualUpdates = manualUpdateTexts(args);
  const manualParsed = await parseManualOverlayUpdates(manualUpdates, ctx, warnings);

  const officers = [...(payload.officers ?? []), ...manualParsed.officers];
  const ships = [...(payload.ships ?? []), ...manualParsed.ships];
  const docks = payload.docks ?? [];

  const officerChanges: Array<{ refId: string; changedFields: string[] }> = [];
  const shipChanges: Array<{ refId: string; changedFields: string[] }> = [];
  const officerReceiptChanges: Array<{
    refId: string;
    changedFields: string[];
    before: {
      ownershipState: OwnershipState;
      level: number | null;
      rank: string | null;
      power: number | null;
    } | null;
    after: SetOfficerOverlayInput;
  }> = [];
  const shipReceiptChanges: Array<{
    refId: string;
    changedFields: string[];
    before: {
      ownershipState: OwnershipState;
      tier: number | null;
      level: number | null;
      power: number | null;
    } | null;
    after: SetShipOverlayInput;
  }> = [];
  const dockChanges: Array<{
    dockNumber: number;
    fromLoadoutId: number | null;
    toLoadoutId: number | null;
    action: "assigned" | "reassigned" | "cleared";
  }> = [];
  let skippedUnknownOfficerRefs = 0;
  let skippedUnknownShipRefs = 0;
  let skippedDockEntries = 0;

  for (const entry of officers) {
    if (!entry?.refId || typeof entry.refId !== "string") {
      warnings.push("Skipped officer entry with missing refId.");
      continue;
    }
    const refId = normalizeOfficerRefId(entry.refId);

    if (ctx.referenceStore) {
      const exists = await ctx.referenceStore.getOfficer(refId);
      if (!exists) {
        skippedUnknownOfficerRefs++;
        continue;
      }
    }

    const patch: SetOfficerOverlayInput = { refId };
    const ownershipState = ownershipFromOwnedFlag(entry.owned);
    if (ownershipState) patch.ownershipState = ownershipState;
    if (entry.level !== undefined) patch.level = entry.level;
    if (entry.rank !== undefined) patch.rank = entry.rank == null ? null : String(entry.rank);
    if (entry.power !== undefined) patch.power = entry.power;
    if (entry.tier !== undefined) {
      warnings.push(`Officer tier ignored for ${refId}; officer overlay does not track tier.`);
    }

    const existing = officerMap.get(refId) ?? null;
    const changedFields = changedOfficerFields(existing, patch);
    if (changedFields.length === 0) continue;
    officerChanges.push({ refId, changedFields });
    officerReceiptChanges.push({ refId, changedFields, before: existing, after: patch });

    if (!dryRun) {
      await ctx.overlayStore.setOfficerOverlay(patch);
    }
  }

  for (const entry of ships) {
    if (!entry?.refId || typeof entry.refId !== "string") {
      warnings.push("Skipped ship entry with missing refId.");
      continue;
    }
    const refId = normalizeShipRefId(entry.refId);

    if (ctx.referenceStore) {
      const exists = await ctx.referenceStore.getShip(refId);
      if (!exists) {
        skippedUnknownShipRefs++;
        continue;
      }
    }

    const patch: SetShipOverlayInput = { refId };
    const ownershipState = ownershipFromOwnedFlag(entry.owned);
    if (ownershipState) patch.ownershipState = ownershipState;
    if (entry.tier !== undefined) patch.tier = entry.tier;
    if (entry.level !== undefined) patch.level = entry.level;
    if (entry.power !== undefined) patch.power = entry.power;

    const existing = shipMap.get(refId) ?? null;
    const changedFields = changedShipFields(existing, patch);
    if (changedFields.length === 0) continue;
    shipChanges.push({ refId, changedFields });
    shipReceiptChanges.push({ refId, changedFields, before: existing, after: patch });

    if (!dryRun) {
      await ctx.overlayStore.setShipOverlay(patch);
    }
  }

  if (docks.length > 0) {
    if (!ctx.crewStore) {
      warnings.push("Dock entries provided but crew store is unavailable; dock sync skipped.");
      skippedDockEntries = docks.length;
    } else {
      const [activePlanItems, activeLoadouts, allLoadouts] = await Promise.all([
        ctx.crewStore.listPlanItems({ active: true }),
        ctx.crewStore.listLoadouts({ active: true }),
        ctx.crewStore.listLoadouts(),
      ]);

      const dockItemMap = new Map<number, { id: number; loadoutId: number | null }>();
      for (const item of activePlanItems) {
        if (item.dockNumber == null || item.awayOfficers) continue;
        if (!dockItemMap.has(item.dockNumber)) {
          dockItemMap.set(item.dockNumber, { id: item.id, loadoutId: item.loadoutId });
        }
      }

      const loadoutCandidates = activeLoadouts.length > 0 ? activeLoadouts : allLoadouts;
      const loadoutByShip = new Map<string, number>();
      for (const loadout of loadoutCandidates) {
        if (!loadoutByShip.has(loadout.shipId)) {
          loadoutByShip.set(loadout.shipId, loadout.id);
        }
      }

      for (const entry of docks) {
        const dockNumber = Number(entry?.number);
        if (!entry || !Number.isInteger(dockNumber) || dockNumber < 1) {
          skippedDockEntries++;
          warnings.push("Skipped dock entry with invalid number (must be integer >= 1).");
          continue;
        }

        let desiredLoadoutId: number | null = null;
        if (entry.loadoutId != null) {
          const parsedLoadoutId = Number(entry.loadoutId);
          if (!Number.isInteger(parsedLoadoutId) || parsedLoadoutId < 1) {
            skippedDockEntries++;
            warnings.push(`Skipped dock ${dockNumber}: invalid loadoutId.`);
            continue;
          }
          desiredLoadoutId = parsedLoadoutId;
        } else if (typeof entry.shipId === "string" && entry.shipId.trim()) {
          const normalizedShipId = normalizeShipRefId(entry.shipId);
          const matchedLoadoutId = loadoutByShip.get(normalizedShipId) ?? null;
          if (matchedLoadoutId == null) {
            skippedDockEntries++;
            warnings.push(`Skipped dock ${dockNumber}: no loadout found for ship ${normalizedShipId}.`);
            continue;
          }
          desiredLoadoutId = matchedLoadoutId;
        }

        const existing = dockItemMap.get(dockNumber);
        const currentLoadoutId = existing?.loadoutId ?? null;
        if (currentLoadoutId === desiredLoadoutId) continue;

        const action: "assigned" | "reassigned" | "cleared" =
          currentLoadoutId == null
            ? "assigned"
            : desiredLoadoutId == null
              ? "cleared"
              : "reassigned";

        dockChanges.push({
          dockNumber,
          fromLoadoutId: currentLoadoutId,
          toLoadoutId: desiredLoadoutId,
          action,
        });

        if (!dryRun) {
          if (existing) {
            await ctx.crewStore.updatePlanItem(existing.id, {
              dockNumber,
              loadoutId: desiredLoadoutId,
              source: "manual",
            });
          } else if (desiredLoadoutId != null) {
            await ctx.crewStore.createPlanItem({
              dockNumber,
              loadoutId: desiredLoadoutId,
              source: "manual",
              label: "sync_overlay import",
            });
          }
        }
      }
    }
  }

  let receiptId: number | null = null;
  if (!dryRun && ctx.receiptStore && (officerReceiptChanges.length > 0 || shipReceiptChanges.length > 0 || dockChanges.length > 0)) {
    const receipt = await ctx.receiptStore.createReceipt({
      sourceType: syncOverlaySourceType(payload.source),
      layer: "ownership",
      sourceMeta: {
        tool: "sync_overlay",
        userId: ctx.userId,
        source: payload.source ?? null,
        exportDate: payload.exportDate ?? null,
      },
      mapping: {
        schemaVersion: payload.version,
      },
      changeset: {
        updated: [
          ...officerReceiptChanges.map((change) => ({
            entity: "officer",
            refId: change.refId,
            changedFields: change.changedFields,
            after: change.after,
          })),
          ...shipReceiptChanges.map((change) => ({
            entity: "ship",
            refId: change.refId,
            changedFields: change.changedFields,
            after: change.after,
          })),
          ...dockChanges.map((change) => ({
            entity: "dock",
            dockNumber: change.dockNumber,
            fromLoadoutId: change.fromLoadoutId,
            toLoadoutId: change.toLoadoutId,
            action: change.action,
          })),
        ],
      },
      inverse: {
        updated: [
          ...officerReceiptChanges.map((change) => ({
            entity: "officer",
            refId: change.refId,
            revert: change.before
              ? {
                  ownershipState: change.before.ownershipState,
                  level: change.before.level,
                  rank: change.before.rank,
                  power: change.before.power,
                }
              : { delete: true },
          })),
          ...shipReceiptChanges.map((change) => ({
            entity: "ship",
            refId: change.refId,
            revert: change.before
              ? {
                  ownershipState: change.before.ownershipState,
                  tier: change.before.tier,
                  level: change.before.level,
                  power: change.before.power,
                }
              : { delete: true },
          })),
          ...dockChanges.map((change) => ({
            entity: "dock",
            dockNumber: change.dockNumber,
            revert: { loadoutId: change.fromLoadoutId },
          })),
        ],
      },
    });
    receiptId = receipt.id;
  }

  return {
    tool: "sync_overlay",
    dryRun,
    schema: {
      version: payload.version,
      source: payload.source ?? null,
      exportDate: payload.exportDate ?? null,
      importAgeDays,
      staleThresholdDays,
      stale: isStale,
      supportedVersion: true,
    },
    summary: {
      officers: {
        input: officers.length,
        manualUpdates: manualParsed.officers.length,
        changed: officerChanges.length,
        unchanged: Math.max(0, officers.length - officerChanges.length - skippedUnknownOfficerRefs),
        skippedUnknownRefs: skippedUnknownOfficerRefs,
        applied: dryRun ? 0 : officerChanges.length,
      },
      ships: {
        input: ships.length,
        manualUpdates: manualParsed.ships.length,
        changed: shipChanges.length,
        unchanged: Math.max(0, ships.length - shipChanges.length - skippedUnknownShipRefs),
        skippedUnknownRefs: skippedUnknownShipRefs,
        applied: dryRun ? 0 : shipChanges.length,
      },
      docks: {
        input: docks.length,
        changed: dockChanges.length,
        skipped: skippedDockEntries,
        applied: dryRun ? 0 : dockChanges.length,
      },
    },
    changesPreview: {
      officers: officerChanges.slice(0, 20),
      ships: shipChanges.slice(0, 20),
      docks: dockChanges.slice(0, 20),
    },
    receipt: {
      created: receiptId != null,
      id: receiptId,
    },
    warnings,
    nextSteps: dryRun
      ? [
          "Review changesPreview and summary.",
          "Re-run sync_overlay with dry_run=false to apply these overlay updates.",
        ]
      : [
          "Overlay updates applied.",
          ...(receiptId != null ? [`Receipt ${receiptId} created for undo/audit.`] : []),
          "Use list_targets or suggest_targets to plan next progression steps.",
        ],
  };
}

export async function syncResearchTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.researchStore) {
    return { tool: "sync_research", error: "Research store not available." };
  }

  const parsed = parseResearchExport(args);
  if (parsed.error) {
    return { tool: "sync_research", error: parsed.error };
  }

  const payload = parsed.data as ReplaceResearchSnapshotInput;
  const dryRun = args.dry_run !== false;

  const treeCounts = new Map<string, number>();
  for (const node of payload.nodes) {
    treeCounts.set(node.tree, (treeCounts.get(node.tree) ?? 0) + 1);
  }
  const stateByNode = new Map(payload.state.map((entry) => [entry.nodeId, entry]));
  const completed = payload.nodes.filter((node) => stateByNode.get(node.nodeId)?.completed === true).length;
  const inProgress = payload.nodes.filter((node) => {
    const level = stateByNode.get(node.nodeId)?.level ?? 0;
    return level > 0 && stateByNode.get(node.nodeId)?.completed !== true;
  }).length;

  if (dryRun) {
    return {
      tool: "sync_research",
      dryRun: true,
      summary: {
        nodes: payload.nodes.length,
        trees: treeCounts.size,
        completed,
        inProgress,
      },
      trees: Array.from(treeCounts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tree, count]) => ({ tree, nodes: count })),
      nextSteps: [
        "Review summary for sanity.",
        "Re-run sync_research with dry_run=false to persist this research snapshot.",
      ],
    };
  }

  const result = await ctx.researchStore.replaceSnapshot(payload);
  return {
    tool: "sync_research",
    dryRun: false,
    summary: {
      nodes: result.nodes,
      trees: result.trees,
      completed,
      inProgress,
    },
    nextSteps: [
      "Research snapshot applied.",
      "Use list_research to inspect tree-level progression.",
    ],
  };
}

// ─── Target Mutation Tools (#80) ────────────────────────────

export async function createTargetTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.targetStore) {
    return { tool: "create_target", error: "Target system not available." };
  }

  const targetType = str(args, "target_type") as TargetType;
  if (!targetType || !VALID_TARGET_TYPES.includes(targetType)) {
    return {
      tool: "create_target",
      error: `Invalid target_type. Must be one of: ${VALID_TARGET_TYPES.join(", ")}.`,
      input: { target_type: targetType || null },
    };
  }

  const refId = str(args, "ref_id") || null;
  const loadoutId = args.loadout_id != null ? Number(args.loadout_id) : null;

  // officer/ship targets should have a ref_id; crew targets should have a loadout_id
  if ((targetType === "officer" || targetType === "ship") && !refId) {
    return {
      tool: "create_target",
      error: `ref_id is required for ${targetType} targets.`,
      input: { target_type: targetType, ref_id: null },
    };
  }
  if (targetType === "crew" && !loadoutId && !refId) {
    return {
      tool: "create_target",
      error: "crew targets require either loadout_id or ref_id.",
      input: { target_type: targetType, loadout_id: null, ref_id: null },
    };
  }

  // Dupe detection — check for active targets with the same ref_id
  if (refId) {
    const existing = await ctx.targetStore.listByRef(refId);
    const activeMatch = existing.find((t) => t.status === "active");
    if (activeMatch) {
      return {
        tool: "create_target",
        status: "duplicate_detected",
        existingId: activeMatch.id,
        existingType: activeMatch.targetType,
        existingPriority: activeMatch.priority,
        existingReason: activeMatch.reason,
        message: `An active ${activeMatch.targetType} target for ${refId} already exists (ID ${activeMatch.id}).`,
        nextSteps: [
          `Use update_target to modify the existing target (ID ${activeMatch.id}).`,
          "Use list_targets to see all current targets.",
        ],
      };
    }
  }

  const priority = args.priority != null ? Number(args.priority) : 2;
  if (priority < 1 || priority > 3) {
    return {
      tool: "create_target",
      error: "Priority must be between 1 and 3 (1 = high, 3 = low).",
      input: { priority },
    };
  }

  const reason = str(args, "reason") || null;
  const targetTier = args.target_tier != null ? Number(args.target_tier) : null;
  const targetLevel = args.target_level != null ? Number(args.target_level) : null;
  const targetRank = str(args, "target_rank") || null;

  const target = await ctx.targetStore.create({
    targetType,
    refId,
    loadoutId,
    priority,
    reason: reason ? reason.slice(0, MAX_NOTES_LEN) : null,
    targetTier,
    targetLevel,
    targetRank,
  });

  return {
    tool: "create_target",
    created: true,
    target: {
      id: target.id,
      targetType: target.targetType,
      refId: target.refId,
      loadoutId: target.loadoutId,
      priority: target.priority,
      reason: target.reason,
      status: target.status,
    },
    nextSteps: [
      "Use list_targets to see all current targets.",
      "Use suggest_targets to get AI-driven acquisition recommendations.",
      "Use complete_target when this goal is achieved.",
    ],
  };
}

export async function updateTargetTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.targetStore) {
    return { tool: "update_target", error: "Target system not available." };
  }

  const targetId = Number(args.target_id);
  if (!targetId || isNaN(targetId)) {
    return {
      tool: "update_target",
      error: "Valid target_id is required.",
      input: { target_id: args.target_id ?? null },
    };
  }

  const existing = await ctx.targetStore.get(targetId);
  if (!existing) {
    return {
      tool: "update_target",
      error: `Target not found with ID ${targetId}.`,
      input: { target_id: targetId },
    };
  }

  const fields: UpdateTargetInput = {};
  let hasUpdates = false;

  if (args.priority != null) {
    const p = Number(args.priority);
    if (p < 1 || p > 3) {
      return {
        tool: "update_target",
        error: "Priority must be between 1 and 3 (1 = high, 3 = low).",
        input: { target_id: targetId, priority: args.priority },
      };
    }
    fields.priority = p;
    hasUpdates = true;
  }

  if (args.status != null) {
    const s = str(args, "status") as TargetStatus;
    if (!VALID_TARGET_STATUSES.includes(s)) {
      return {
        tool: "update_target",
        error: `Invalid status. Must be one of: ${VALID_TARGET_STATUSES.join(", ")}.`,
        input: { target_id: targetId, status: s },
      };
    }
    // For "achieved", direct to complete_target which uses markAchieved
    if (s === "achieved") {
      return {
        tool: "update_target",
        error: "To mark a target achieved, use complete_target instead — it records the achievement timestamp.",
        input: { target_id: targetId, status: s },
        nextSteps: [`Call complete_target with target_id ${targetId}.`],
      };
    }
    fields.status = s;
    hasUpdates = true;
  }

  if (args.reason != null) {
    fields.reason = str(args, "reason").slice(0, MAX_NOTES_LEN) || null;
    hasUpdates = true;
  }
  if (args.target_tier != null) {
    fields.targetTier = Number(args.target_tier);
    hasUpdates = true;
  }
  if (args.target_level != null) {
    fields.targetLevel = Number(args.target_level);
    hasUpdates = true;
  }
  if (args.target_rank != null) {
    fields.targetRank = str(args, "target_rank") || null;
    hasUpdates = true;
  }

  if (!hasUpdates) {
    return {
      tool: "update_target",
      error: "No fields to update — provide at least one of: priority, status, reason, target_tier, target_level, target_rank.",
      input: { target_id: targetId },
    };
  }

  const updated = await ctx.targetStore.update(targetId, fields);
  if (!updated) {
    return { tool: "update_target", error: `Failed to update target ${targetId}.` };
  }

  return {
    tool: "update_target",
    updated: true,
    target: {
      id: updated.id,
      targetType: updated.targetType,
      refId: updated.refId,
      priority: updated.priority,
      status: updated.status,
      reason: updated.reason,
    },
    nextSteps: [
      "Use list_targets to see updated target list.",
      updated.status === "abandoned"
        ? "Target has been abandoned — it will no longer appear in active recommendations."
        : "Use complete_target when this goal is achieved.",
    ],
  };
}

export async function completeTargetTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.targetStore) {
    return { tool: "complete_target", error: "Target system not available." };
  }

  const targetId = Number(args.target_id);
  if (!targetId || isNaN(targetId)) {
    return {
      tool: "complete_target",
      error: "Valid target_id is required.",
      input: { target_id: args.target_id ?? null },
    };
  }

  const existing = await ctx.targetStore.get(targetId);
  if (!existing) {
    return {
      tool: "complete_target",
      error: `Target not found with ID ${targetId}.`,
      input: { target_id: targetId },
    };
  }

  if (existing.status === "achieved") {
    return {
      tool: "complete_target",
      status: "already_achieved",
      target: {
        id: existing.id,
        targetType: existing.targetType,
        refId: existing.refId,
        achievedAt: existing.achievedAt,
      },
      message: "This target was already marked as achieved.",
    };
  }

  if (existing.status === "abandoned") {
    return {
      tool: "complete_target",
      error: "Cannot complete an abandoned target. Use update_target to reactivate it first (set status to 'active').",
      input: { target_id: targetId },
    };
  }

  const achieved = await ctx.targetStore.markAchieved(targetId);
  if (!achieved) {
    return { tool: "complete_target", error: `Failed to mark target ${targetId} as achieved.` };
  }

  return {
    tool: "complete_target",
    completed: true,
    target: {
      id: achieved.id,
      targetType: achieved.targetType,
      refId: achieved.refId,
      priority: achieved.priority,
      reason: achieved.reason,
      status: achieved.status,
      achievedAt: achieved.achievedAt,
    },
    nextSteps: [
      "Use suggest_targets for new acquisition recommendations.",
      "Use list_targets with status 'achieved' to review accomplishments.",
    ],
  };
}

// ─── Overlay Mutation Tools ─────────────────────────────────

/**
 * Set or update a ship's personal overlay: ownership state, current tier/level/power.
 * This lets the Admiral record their actual in-game ship progression.
 */
export async function setShipOverlayTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.overlayStore) {
    return { tool: "set_ship_overlay", error: "Overlay store not available." };
  }

  const shipId = str(args, "ship_id");
  if (!shipId) {
    return { tool: "set_ship_overlay", error: "ship_id is required.", input: args };
  }

  if (args.ownership_state != null && !VALID_OWNERSHIP_STATES.includes(args.ownership_state as OwnershipState)) {
    return {
      tool: "set_ship_overlay",
      error: `Invalid ownership_state. Must be one of: ${VALID_OWNERSHIP_STATES.join(", ")}`,
      input: { ownership_state: args.ownership_state },
    };
  }

  const input: SetShipOverlayInput = { refId: shipId };
  if (args.ownership_state != null) input.ownershipState = args.ownership_state as OwnershipState;
  if (args.tier != null) input.tier = Number(args.tier);
  if (args.level != null) input.level = Number(args.level);
  if (args.power != null) input.power = Number(args.power);
  if (args.target != null) input.target = Boolean(args.target);
  if (args.target_note != null) input.targetNote = str(args, "target_note").slice(0, MAX_NOTES_LEN);

  const overlay = await ctx.overlayStore.setShipOverlay(input);

  return {
    tool: "set_ship_overlay",
    updated: true,
    shipId,
    overlay: {
      ownershipState: overlay.ownershipState,
      tier: overlay.tier,
      level: overlay.level,
      power: overlay.power,
      target: overlay.target,
      targetNote: overlay.targetNote,
    },
    nextSteps: ["Use get_ship_detail to see the full ship record with updated overlay."],
  };
}

/**
 * Record inventory items from manual chat input ("I have 280 3-star Ore").
 * Upserts items by (category, name, grade) key — existing entries get updated quantities.
 */
export async function updateInventoryTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.inventoryStore) {
    return { tool: "update_inventory", error: "Inventory store not available." };
  }

  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return {
      tool: "update_inventory",
      error: "items array is required and must contain at least one item.",
      input: { items: rawItems },
    };
  }

  const VALID_CATEGORIES = ["ore", "gas", "crystal", "parts", "currency", "blueprint", "other"];
  const validatedItems: Array<{ category: string; name: string; grade: string | null; quantity: number; unit: string | null }> = [];
  const errors: string[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i] as Record<string, unknown>;
    const category = String(item.category ?? "").trim().toLowerCase();
    const name = String(item.name ?? "").trim();
    const grade = item.grade != null ? String(item.grade).trim() : null;
    const quantity = Number(item.quantity ?? 0);

    if (!VALID_CATEGORIES.includes(category)) {
      errors.push(`Item ${i}: invalid category '${category}'. Must be one of: ${VALID_CATEGORIES.join(", ")}`);
      continue;
    }
    if (!name) {
      errors.push(`Item ${i}: name is required.`);
      continue;
    }
    if (name.length > MAX_NAME_LEN) {
      errors.push(`Item ${i}: name must be ${MAX_NAME_LEN} characters or fewer.`);
      continue;
    }
    if (!Number.isFinite(quantity) || quantity < 0) {
      errors.push(`Item ${i}: quantity must be a non-negative number.`);
      continue;
    }

    validatedItems.push({ category, name, grade, quantity, unit: null });
  }

  if (validatedItems.length === 0) {
    return {
      tool: "update_inventory",
      error: "No valid items to record.",
      validationErrors: errors,
      input: { items: rawItems },
    };
  }

  const source = str(args, "source") || "chat";
  const result = await ctx.inventoryStore.upsertItems({
    source,
    capturedAt: new Date().toISOString(),
    items: validatedItems.map(v => ({
      category: v.category as import("../../stores/inventory-store.js").InventoryCategory,
      name: v.name,
      grade: v.grade,
      quantity: v.quantity,
      unit: v.unit,
    })),
  });

  return {
    tool: "update_inventory",
    recorded: true,
    upserted: result.upserted,
    categories: result.categories,
    items: validatedItems.map(v => ({ category: v.category, name: v.name, grade: v.grade, quantity: v.quantity })),
    ...(errors.length > 0 ? { warnings: errors } : {}),
    nextSteps: [
      "Use list_inventory to verify the recorded inventory.",
      "Use calculate_upgrade_path to check resource gaps for a specific ship upgrade.",
    ],
  };
}

/**
 * Set or update an officer's personal overlay: ownership state, current level/rank/power.
 * This lets the Admiral record their actual in-game officer progression.
 */
export async function setOfficerOverlayTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.overlayStore) {
    return { tool: "set_officer_overlay", error: "Overlay store not available." };
  }

  const officerId = str(args, "officer_id");
  if (!officerId) {
    return { tool: "set_officer_overlay", error: "officer_id is required.", input: args };
  }

  if (args.ownership_state != null && !VALID_OWNERSHIP_STATES.includes(args.ownership_state as OwnershipState)) {
    return {
      tool: "set_officer_overlay",
      error: `Invalid ownership_state. Must be one of: ${VALID_OWNERSHIP_STATES.join(", ")}`,
      input: { ownership_state: args.ownership_state },
    };
  }

  const input: SetOfficerOverlayInput = { refId: officerId };
  if (args.ownership_state != null) input.ownershipState = args.ownership_state as OwnershipState;
  if (args.level != null) input.level = Number(args.level);
  if (args.rank != null) input.rank = str(args, "rank");
  if (args.power != null) input.power = Number(args.power);
  if (args.target != null) input.target = Boolean(args.target);
  if (args.target_note != null) input.targetNote = str(args, "target_note").slice(0, MAX_NOTES_LEN);

  const overlay = await ctx.overlayStore.setOfficerOverlay(input);

  return {
    tool: "set_officer_overlay",
    updated: true,
    officerId,
    overlay: {
      ownershipState: overlay.ownershipState,
      level: overlay.level,
      rank: overlay.rank,
      power: overlay.power,
      target: overlay.target,
      targetNote: overlay.targetNote,
    },
    nextSteps: ["Use get_officer_detail to see the full officer record with updated overlay."],
  };
}

// ─── Dock Assignment Tools ────────────────────────────────────

export async function assignDockTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "assign_dock", error: "Crew system not available." };
  }

  const dockNumber = args.dock_number != null ? Number(args.dock_number) : NaN;
  if (!Number.isInteger(dockNumber) || dockNumber < 1) {
    return {
      tool: "assign_dock",
      error: "dock_number must be a positive integer (e.g. 1, 2, 3).",
      input: { dock_number: args.dock_number ?? null },
    };
  }

  const loadoutId = args.loadout_id != null ? Number(args.loadout_id) : undefined;
  const variantId = args.variant_id != null ? Number(args.variant_id) : undefined;

  if (!loadoutId && !variantId) {
    return {
      tool: "assign_dock",
      error: "At least one of loadout_id or variant_id is required.",
      input: { loadout_id: null, variant_id: null },
    };
  }

  const label = str(args, "label") || undefined;
  const notes = validNotes(args);

  // Ensure the dock slot exists
  await ctx.crewStore.upsertDock(dockNumber, {
    label: label ?? `Dock ${dockNumber}`,
    unlocked: true,
  });

  // Deactivate any existing plan items for this dock
  const existingItems = await ctx.crewStore.listPlanItems({ dockNumber, active: true });
  for (const item of existingItems) {
    await ctx.crewStore.updatePlanItem(item.id, { isActive: false });
  }

  // Create the new plan item
  const planItem = await ctx.crewStore.createPlanItem({
    dockNumber,
    loadoutId,
    variantId,
    source: "manual",
    label: label ?? `Dock ${dockNumber} assignment`,
    isActive: true,
    notes,
  });

  return {
    tool: "assign_dock",
    created: true,
    planItem: {
      id: planItem.id,
      dockNumber: planItem.dockNumber,
      loadoutId: planItem.loadoutId,
      variantId: planItem.variantId,
      label: planItem.label,
    },
    nextSteps: [
      "Use get_effective_state to verify the full dock configuration.",
      "Use validate_plan to check for officer conflicts.",
    ],
  };
}

export async function updateDockTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "update_dock", error: "Crew system not available." };
  }

  const planItemId = args.plan_item_id != null ? Number(args.plan_item_id) : NaN;
  if (!Number.isInteger(planItemId) || planItemId < 1) {
    return {
      tool: "update_dock",
      error: "plan_item_id is required and must be a positive integer.",
      input: { plan_item_id: args.plan_item_id ?? null },
    };
  }

  const existing = await ctx.crewStore.getPlanItem(planItemId);
  if (!existing) {
    return {
      tool: "update_dock",
      error: `Plan item ${planItemId} not found.`,
      input: { plan_item_id: planItemId },
    };
  }

  const fields: Record<string, unknown> = {};
  if (args.loadout_id != null) fields.loadoutId = Number(args.loadout_id);
  if (args.variant_id != null) fields.variantId = Number(args.variant_id);
  if (args.dock_number != null) fields.dockNumber = Number(args.dock_number);
  if (args.label != null) fields.label = str(args, "label");
  if (args.is_active != null) fields.isActive = Boolean(args.is_active);
  fields.notes = validNotes(args);

  const updated = await ctx.crewStore.updatePlanItem(planItemId, fields);
  if (!updated) {
    return { tool: "update_dock", error: `Failed to update plan item ${planItemId}.` };
  }

  return {
    tool: "update_dock",
    updated: true,
    planItem: {
      id: updated.id,
      dockNumber: updated.dockNumber,
      loadoutId: updated.loadoutId,
      variantId: updated.variantId,
      label: updated.label,
      isActive: updated.isActive,
    },
    nextSteps: [
      "Use get_effective_state to verify the updated dock configuration.",
    ],
  };
}

export async function removeDockAssignmentTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "remove_dock_assignment", error: "Crew system not available." };
  }

  const dockNumber = args.dock_number != null ? Number(args.dock_number) : NaN;
  if (!Number.isInteger(dockNumber) || dockNumber < 1) {
    return {
      tool: "remove_dock_assignment",
      error: "dock_number must be a positive integer.",
      input: { dock_number: args.dock_number ?? null },
    };
  }

  // Deactivate all active plan items for this dock
  const items = await ctx.crewStore.listPlanItems({ dockNumber, active: true });
  if (items.length === 0) {
    return {
      tool: "remove_dock_assignment",
      removed: false,
      message: `Dock ${dockNumber} has no active assignments to remove.`,
    };
  }

  for (const item of items) {
    await ctx.crewStore.updatePlanItem(item.id, { isActive: false });
  }

  return {
    tool: "remove_dock_assignment",
    removed: true,
    dockNumber,
    deactivatedCount: items.length,
    nextSteps: [
      "Use get_effective_state to verify the dock is now empty.",
      "Use assign_dock to assign a new loadout to this dock.",
    ],
  };
}
