/**
 * fleet-tools/mutate-tools-sync.ts — Bulk import / sync mutation tools
 *
 * Majel — STFC Fleet Intelligence System
 *
 * sync_overlay (game export → overlay) and sync_research (research snapshot).
 * Both follow the dry-run preview → apply → receipt pattern.
 * Extracted from mutate-tools.ts (#193).
 */

import type { ToolEnv } from "./declarations.js";
import type { OwnershipState, SetShipOverlayInput, SetOfficerOverlayInput } from "../../stores/overlay-store.js";
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

// ─── Internal helpers (sync-domain only) ────────────────────

async function parseManualOverlayUpdates(
  updates: string[],
  ctx: ToolEnv,
  warnings: string[],
): Promise<{ officers: SyncOverlayOfficerInput[]; ships: SyncOverlayShipInput[] }> {
  const officers: SyncOverlayOfficerInput[] = [];
  const ships: SyncOverlayShipInput[] = [];

  if (updates.length === 0) {
    return { officers, ships };
  }
  if (!ctx.deps.referenceStore) {
    warnings.push("manual_updates provided but reference store is unavailable; could not resolve entities.");
    return { officers, ships };
  }

  for (const update of updates) {
    const shipBulkMatch = update.match(
      /(?:^|\b)all\s+(?:of\s+my\s+|my\s+)?ships(?:\s+except\s+(.+?))?\s+are\s+max\s+(?:tier(?:\s+and\s+level)?|level\s+and\s+tier)(?:\b.*)?$/i,
    );
    if (shipBulkMatch) {
      const excludedNames = parseExceptionNames(shipBulkMatch[1]);
      const allShips = await ctx.deps.referenceStore.listShips();
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
      const allOfficers = await ctx.deps.referenceStore.listOfficers();
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
      ctx.deps.referenceStore.searchOfficers(name),
      ctx.deps.referenceStore.searchShips(name),
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

// ─── Sync Overlay ───────────────────────────────────────────

export async function syncOverlayTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.overlayStore) {
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
    ctx.deps.overlayStore.listOfficerOverlays(),
    ctx.deps.overlayStore.listShipOverlays(),
  ]);
  const officerMap = new Map(officerOverlays.map((row) => [`${row.refId}:${row.instanceId}`, row]));
  const shipMap = new Map(shipOverlays.map((row) => [`${row.refId}:${row.instanceId}`, row]));
  const matchedOfficerKeys = new Set<string>();
  const matchedShipKeys = new Set<string>();

  const manualUpdates = manualUpdateTexts(args);
  const manualParsed = await parseManualOverlayUpdates(manualUpdates, ctx, warnings);

  const officers = [...(payload.officers ?? []), ...manualParsed.officers];
  const ships = [...(payload.ships ?? []), ...manualParsed.ships];
  const docks = payload.docks ?? [];

  const officerChanges: Array<{ refId: string; instanceId: string; changedFields: string[] }> = [];
  const shipChanges: Array<{ refId: string; instanceId: string; changedFields: string[] }> = [];
  const officerReceiptChanges: Array<{
    refId: string;
    instanceId: string;
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
    instanceId: string;
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
    const instanceId = typeof entry.instanceId === "string" && entry.instanceId ? entry.instanceId : "primary";

    if (ctx.deps.referenceStore) {
      const exists = await ctx.deps.referenceStore.getOfficer(refId);
      if (!exists) {
        skippedUnknownOfficerRefs++;
        continue;
      }
    }

    const patch: SetOfficerOverlayInput = { refId, instanceId };
    const ownershipState = ownershipFromOwnedFlag(entry.owned);
    if (ownershipState) patch.ownershipState = ownershipState;
    if (entry.level !== undefined) patch.level = entry.level;
    if (entry.rank !== undefined) patch.rank = entry.rank == null ? null : String(entry.rank);
    if (entry.power !== undefined) patch.power = entry.power;
    if (entry.tier !== undefined) {
      warnings.push(`Officer tier ignored for ${refId}; officer overlay does not track tier.`);
    }

    const compositeKey = `${refId}:${instanceId}`;
    matchedOfficerKeys.add(compositeKey);
    const existing = officerMap.get(compositeKey) ?? null;
    const changedFields = changedOfficerFields(existing, patch);
    if (changedFields.length === 0) continue;
    officerChanges.push({ refId, instanceId, changedFields });
    officerReceiptChanges.push({ refId, instanceId, changedFields, before: existing, after: patch });

    if (!dryRun) {
      await ctx.deps.overlayStore.setOfficerOverlay(patch);
    }
  }

  for (const entry of ships) {
    if (!entry?.refId || typeof entry.refId !== "string") {
      warnings.push("Skipped ship entry with missing refId.");
      continue;
    }
    const refId = normalizeShipRefId(entry.refId);
    const instanceId = typeof entry.instanceId === "string" && entry.instanceId ? entry.instanceId : "primary";

    if (ctx.deps.referenceStore) {
      const exists = await ctx.deps.referenceStore.getShip(refId);
      if (!exists) {
        skippedUnknownShipRefs++;
        continue;
      }
    }

    const patch: SetShipOverlayInput = { refId, instanceId };
    const ownershipState = ownershipFromOwnedFlag(entry.owned);
    if (ownershipState) patch.ownershipState = ownershipState;
    if (entry.tier !== undefined) patch.tier = entry.tier;
    if (entry.level !== undefined) patch.level = entry.level;
    if (entry.power !== undefined) patch.power = entry.power;

    const compositeKey = `${refId}:${instanceId}`;
    matchedShipKeys.add(compositeKey);
    const existing = shipMap.get(compositeKey) ?? null;
    const changedFields = changedShipFields(existing, patch);
    if (changedFields.length === 0) continue;
    shipChanges.push({ refId, instanceId, changedFields });
    shipReceiptChanges.push({ refId, instanceId, changedFields, before: existing, after: patch });

    if (!dryRun) {
      await ctx.deps.overlayStore.setShipOverlay(patch);
    }
  }

  if (docks.length > 0) {
    if (!ctx.deps.crewStore) {
      warnings.push("Dock entries provided but crew store is unavailable; dock sync skipped.");
      skippedDockEntries = docks.length;
    } else {
      const [activePlanItems, activeLoadouts, allLoadouts] = await Promise.all([
        ctx.deps.crewStore.listPlanItems({ active: true }),
        ctx.deps.crewStore.listLoadouts({ active: true }),
        ctx.deps.crewStore.listLoadouts(),
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
            await ctx.deps.crewStore.updatePlanItem(existing.id, {
              dockNumber,
              loadoutId: desiredLoadoutId,
              source: "manual",
            });
          } else if (desiredLoadoutId != null) {
            await ctx.deps.crewStore.createPlanItem({
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
  if (!dryRun && ctx.deps.receiptStore && (officerReceiptChanges.length > 0 || shipReceiptChanges.length > 0 || dockChanges.length > 0)) {
    const receipt = await ctx.deps.receiptStore.createReceipt({
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
            instanceId: change.instanceId,
            changedFields: change.changedFields,
            after: change.after,
          })),
          ...shipReceiptChanges.map((change) => ({
            entity: "ship",
            refId: change.refId,
            instanceId: change.instanceId,
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
            instanceId: change.instanceId,
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
            instanceId: change.instanceId,
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

  const unmatchedOfficerInstances = [...officerMap.keys()].filter((key) => !matchedOfficerKeys.has(key));
  const unmatchedShipInstances = [...shipMap.keys()].filter((key) => !matchedShipKeys.has(key));

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
        unmatchedInstances: unmatchedOfficerInstances.length,
        applied: dryRun ? 0 : officerChanges.length,
      },
      ships: {
        input: ships.length,
        manualUpdates: manualParsed.ships.length,
        changed: shipChanges.length,
        unchanged: Math.max(0, ships.length - shipChanges.length - skippedUnknownShipRefs),
        skippedUnknownRefs: skippedUnknownShipRefs,
        unmatchedInstances: unmatchedShipInstances.length,
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

// ─── Sync Research ──────────────────────────────────────────

export async function syncResearchTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.researchStore) {
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

  const result = await ctx.deps.researchStore.replaceSnapshot(payload);
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
