import type { ToolContext } from "./declarations.js";
import { officerClassLabel, hullTypeLabel } from "../game-enums.js";
import { normalizeToken, extractTierRequirements } from "./read-tools-upgrade-helpers.js";
import { normalizeFactionStanding, readUserJsonSetting } from "./read-tools-context-helpers.js";

export async function suggestTargets(ctx: ToolContext): Promise<object> {
  const result: Record<string, unknown> = {};
  let ownedShipsForRecommendations: Array<{ id: string; name: string; faction: string | null }> = [];

  if (ctx.referenceStore) {
    const refCounts = await ctx.referenceStore.counts();
    result.catalogSize = { officers: refCounts.officers, ships: refCounts.ships };
  }

  if (ctx.overlayStore && ctx.referenceStore) {
    const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
    const allOfficers = await ctx.referenceStore.listOfficers();
    const refMap = new Map(allOfficers.map(o => [o.id, o]));
    result.ownedOfficers = overlays
      .map((overlay) => {
        const ref = refMap.get(overlay.refId);
        if (!ref) return null;
        return {
          id: ref.id,
          name: ref.name,
          rarity: ref.rarity,
          group: ref.groupName,
          officerClass: officerClassLabel(ref.officerClass),
          faction: ref.faction ? (ref.faction as Record<string, unknown>).name ?? null : null,
          captainManeuver: ref.captainManeuver,
          officerAbility: ref.officerAbility,
          belowDeckAbility: ref.belowDeckAbility,
          level: overlay.level,
          rank: overlay.rank,
        };
      })
      .filter(Boolean);
  }

  if (ctx.overlayStore && ctx.referenceStore) {
    const overlays = await ctx.overlayStore.listShipOverlays({ ownershipState: "owned" });
    const allShips = await ctx.referenceStore.listShips();
    const shipMap = new Map(allShips.map(s => [s.id, s]));
    const ownedShips = overlays
      .map((overlay) => {
        const ref = shipMap.get(overlay.refId);
        if (!ref) return null;
        return {
          id: ref.id,
          name: ref.name,
          shipClass: ref.shipClass,
          grade: ref.grade,
          rarity: ref.rarity,
          faction: ref.faction,
          hullType: hullTypeLabel(ref.hullType),
          tier: overlay.tier ?? ref.tier,
          level: overlay.level,
        };
      })
      .filter(Boolean);
    result.ownedShips = ownedShips;
    ownedShipsForRecommendations = ownedShips
      .map((entry) => ({
        id: String((entry as Record<string, unknown>).id),
        name: String((entry as Record<string, unknown>).name),
        faction: (entry as Record<string, unknown>).faction == null
          ? null
          : String((entry as Record<string, unknown>).faction),
      }));
  }

  if (ctx.crewStore) {
    const loadouts = await ctx.crewStore.listLoadouts();
    result.loadouts = loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      shipId: l.shipId,
      intentKeys: l.intentKeys,
    }));
  }

  if (ctx.targetStore) {
    const targets = await ctx.targetStore.list({ status: "active" } as never);
    result.existingTargets = targets.map((t) => ({
      id: t.id,
      targetType: t.targetType,
      refId: t.refId,
      loadoutId: t.loadoutId,
      reason: t.reason,
      priority: t.priority,
    }));
  }

  if (ctx.crewStore) {
    const state = await ctx.crewStore.getEffectiveDockState();
    result.officerConflicts = state.conflicts.map((c) => ({
      officerId: c.officerId,
      locationCount: c.locations.length,
    }));
  }

  if (ctx.overlayStore) {
    const targetedOfficers = await ctx.overlayStore.listOfficerOverlays({ target: true });
    const targetedShips = await ctx.overlayStore.listShipOverlays({ target: true });
    result.overlayTargets = {
      officers: targetedOfficers.length,
      ships: targetedShips.length,
    };
  }

  const standingsData = await readUserJsonSetting<unknown>(ctx, "fleet.factionStandings", {});
  const factionStandings = normalizeFactionStanding(standingsData.value);
  if (factionStandings.length > 0 || standingsData.source !== "unavailable") {
    result.factionStandings = factionStandings;
  }

  if (ownedShipsForRecommendations.length > 0) {
    const standingByFaction = new Map(
      factionStandings.map((row) => [row.faction.trim().toLowerCase(), row]),
    );

    const eligible: Array<Record<string, unknown>> = [];
    const blocked: Array<Record<string, unknown>> = [];

    for (const ship of ownedShipsForRecommendations) {
      if (!ship.faction || ship.faction.toLowerCase() === "neutral") continue;
      const standing = standingByFaction.get(ship.faction.trim().toLowerCase()) ?? {
        faction: ship.faction,
        reputation: null,
        tier: null,
        storeAccess: "limited" as const,
      };
      if (standing.storeAccess === "open") {
        eligible.push({
          shipId: ship.id,
          shipName: ship.name,
          faction: ship.faction,
          access: standing.storeAccess,
        });
        continue;
      }
      blocked.push({
        shipId: ship.id,
        shipName: ship.name,
        faction: ship.faction,
        access: standing.storeAccess,
        reason: "faction_store_access_insufficient",
      });
    }

    if (eligible.length > 0 || blocked.length > 0) {
      result.storeRecommendations = {
        eligibleBlueprintAccess: eligible,
        blockedByFactionAccess: blocked,
      };
    }
  }

  if (ctx.inventoryStore && ctx.overlayStore && ctx.referenceStore) {
    try {
      const ownedShipOverlays = await ctx.overlayStore.listShipOverlays({ ownershipState: "owned" });
      const allShips = await ctx.referenceStore.listShips();
      const shipRefMap = new Map(allShips.map(s => [s.id, s]));
      const inventory = await ctx.inventoryStore.listItems();
      const inventoryMap = new Map<string, number>();
      for (const inv of inventory) {
        const key = normalizeToken(inv.name);
        inventoryMap.set(key, (inventoryMap.get(key) ?? 0) + inv.quantity);
      }

      const readyToUpgrade: Array<{
        shipId: string;
        shipName: string;
        currentTier: number;
        nextTier: number;
        coveragePct: number;
      }> = [];

      for (const overlay of ownedShipOverlays) {
        const ref = shipRefMap.get(overlay.refId);
        if (!ref?.tiers || !Array.isArray(ref.tiers)) continue;
        const currentTier = overlay.tier ?? ref.tier ?? 1;
        const nextTier = currentTier + 1;
        const maxTier = ref.maxTier ?? 99;
        if (nextTier > maxTier) continue;

        const requirements = extractTierRequirements(ref.tiers, currentTier, nextTier);
        if (requirements.length === 0) continue;

        let totalRequired = 0;
        let totalAvailable = 0;
        for (const req of requirements) {
          const available = inventoryMap.get(normalizeToken(req.name)) ?? 0;
          totalRequired += req.amount;
          totalAvailable += Math.min(available, req.amount);
        }
        const coveragePct = totalRequired > 0 ? Math.round((totalAvailable / totalRequired) * 100) : 0;
        if (coveragePct >= 80) {
          readyToUpgrade.push({
            shipId: overlay.refId,
            shipName: ref.name,
            currentTier,
            nextTier,
            coveragePct,
          });
        }
      }

      if (readyToUpgrade.length > 0) {
        readyToUpgrade.sort((a, b) => b.coveragePct - a.coveragePct);
        result.readyToUpgrade = readyToUpgrade.slice(0, 10);
      }
    } catch (_err) {
      void _err;
    }
  }

  return result;
}