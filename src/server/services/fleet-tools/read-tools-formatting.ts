/**
 * read-tools-formatting.ts — Shared formatting & name-resolution helpers
 *
 * Private helpers used by multiple read-tool domain modules.
 */

import type { ToolEnv } from "./declarations.js";
import { resolveResourceId, type ResolvedResource } from "../resource-defs.js";

export function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

export async function buildOfficerNameMap(
  officerIds: Iterable<string>,
  ctx: ToolEnv,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(Array.from(officerIds).filter(Boolean)));
  const map = new Map<string, string>();
  if (ids.length === 0 || !ctx.deps.referenceStore) return map;

  const officers = await ctx.deps.referenceStore.listOfficers();
  const lookup = new Map(officers.map((officer) => [officer.id, officer.name]));
  for (const id of ids) {
    const name = lookup.get(id);
    if (name) map.set(id, name);
  }
  return map;
}

export async function buildShipNameMap(
  shipIds: Iterable<string>,
  ctx: ToolEnv,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(Array.from(shipIds).filter(Boolean)));
  const map = new Map<string, string>();
  if (ids.length === 0 || !ctx.deps.referenceStore) return map;

  const ships = await ctx.deps.referenceStore.listShips();
  const lookup = new Map(ships.map((ship) => [ship.id, ship.name]));
  for (const id of ids) {
    const name = lookup.get(id);
    if (name) map.set(id, name);
  }
  return map;
}

function annotateBuildCostEntries(raw: unknown, ctx: ToolEnv): unknown {
  if (!Array.isArray(raw)) return raw;

  return raw.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const item = entry as Record<string, unknown>;
    const rawId = item.resource_id ?? item.resourceId ?? item.id ?? item.type;
    const numericId = typeof rawId === "number"
      ? rawId
      : (typeof rawId === "string" && rawId.trim() ? Number(rawId) : NaN);

    if (!Number.isFinite(numericId)) return entry;

    const hasVerifiedResource = Boolean(ctx.deps.resourceDefs?.has(numericId));
    const resolved = ctx.deps.resourceDefs ? resolveResourceId(numericId, ctx.deps.resourceDefs) : null;
    const existingName = typeof item.name === "string" && item.name.trim() ? item.name.trim() : null;
    const resolvedName = resolved?.name ?? `Unknown resource (${numericId})`;
    const next = Object.create(null) as Record<string, unknown>;

    for (const [key, value] of Object.entries(item)) {
      if (isUnsafeObjectKey(key)) continue;
      next[key] = value;
    }

    next.name = resolvedName;
    next.resourceName = resolvedName;
    next.resourceNameVerified = hasVerifiedResource;
    if (!hasVerifiedResource && existingName) {
      next.unverifiedSourceNamePresent = true;
    }

    return next;
  });
}

export function annotateBuildCostResources(raw: unknown, ctx: ToolEnv): unknown {
  if (Array.isArray(raw)) {
    return raw.map((entry) => annotateBuildCostResources(entry, ctx));
  }
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const record = raw as Record<string, unknown>;
  const next = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (isUnsafeObjectKey(key)) {
      continue;
    }
    if (key === "build_cost" || key === "buildCost") {
      next[key] = annotateBuildCostEntries(value, ctx);
      continue;
    }
    next[key] = annotateBuildCostResources(value, ctx);
  }
  return next;
}

/**
 * Resolve raw mineResources JSONB (array of `{id: number}`) to human-readable
 * objects via the resource definition map.
 */
export function resolveSystemMineResources(
  raw: Record<string, unknown>[] | null,
  ctx: ToolEnv,
): ResolvedResource[] | null {
  if (!raw || raw.length === 0) return null;
  const defs = ctx.deps.resourceDefs;
  if (!defs || defs.size === 0) {
    return raw.map((r) => ({
      id: typeof r.id === "number" ? r.id : 0,
      name: "I can't verify from Majel dataset",
      grade: -1,
      category: "other" as const,
      resourceKey: "unresolved",
    }));
  }
  return raw.map((r) => {
    const gameId = typeof r === "number" ? r : (typeof r.id === "number" ? r.id : 0);
    return resolveResourceId(gameId, defs);
  });
}

export async function resolveHostileSystems(
  rawSystemIds: string[] | null,
  ctx: ToolEnv,
): Promise<{ names: string[] | null; refs: { id: string; name: string }[] | null }> {
  if (!rawSystemIds || rawSystemIds.length === 0 || !ctx.deps.referenceStore) {
    return { names: null, refs: null };
  }

  const refs = await Promise.all(rawSystemIds.map(async (rawId) => {
    const system = await ctx.deps.referenceStore!.getSystem(`cdn:system:${rawId}`);
    return {
      id: rawId,
      name: system?.name ?? `System ${rawId}`,
    };
  }));

  return {
    names: refs.map((ref) => ref.name),
    refs,
  };
}
