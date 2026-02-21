/**
 * fleet-tools/read-tools.ts — Read-Only Tool Implementations
 *
 * Majel — STFC Fleet Intelligence System
 *
 * All read-only fleet intelligence tools. Safe to call without confirmation.
 * Covers: fleet overview, search, details, docks, conflicts, crew composition,
 * targets, and analysis.
 */

import type { ToolContext } from "./declarations.js";
import { detectTargetConflicts } from "../target-conflicts.js";
import { SEED_INTENTS, type SeedIntent } from "../../types/crew-types.js";
import { hullTypeLabel, officerClassLabel } from "../game-enums.js";
import type { ResearchBuff, ResearchNodeRecord } from "../../stores/research-store.js";
import type { InventoryCategory } from "../../stores/inventory-store.js";
import { log } from "../../logger.js";

/** Maximum results for search tools to avoid overwhelming the model context. */
const SEARCH_LIMIT = 20;
const RESEARCH_STALE_DAYS = 7;
const WEB_LOOKUP_ALLOWLIST = new Set(["stfc.space", "memory-alpha.fandom.com", "stfc.fandom.com"]);
const WEB_LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000;
const WEB_LOOKUP_RATE_LIMIT_MAX = 5;
const WEB_LOOKUP_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const webLookupCache = new Map<string, { expiresAt: number; payload: object }>();
const webLookupRateLimit = new Map<string, number[]>();
const robotsCache = new Map<string, { checkedAt: number; disallowAll: boolean }>();
const webLookupMetrics = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  rateLimited: 0,
  robotsBlocked: 0,
  failures: 0,
};

interface ActiveEventRecord {
  name: string;
  type: string;
  scoring: Record<string, unknown>;
  startTime: string | null;
  endTime: string | null;
  isActive: boolean;
}

interface AwayTeamRecord {
  officerId: string;
  missionName: string;
  returnTime: string | null;
  isActive: boolean;
}

interface FactionStandingRecord {
  faction: string;
  reputation: number | null;
  tier: string | null;
  storeAccess: "locked" | "limited" | "open";
}

export function __resetWebLookupStateForTests(): void {
  webLookupCache.clear();
  webLookupRateLimit.clear();
  robotsCache.clear();
  webLookupMetrics.requests = 0;
  webLookupMetrics.cacheHits = 0;
  webLookupMetrics.cacheMisses = 0;
  webLookupMetrics.rateLimited = 0;
  webLookupMetrics.robotsBlocked = 0;
  webLookupMetrics.failures = 0;
}

type ResearchPriority = "none" | "low" | "medium";

interface ResearchAdvisory {
  status: "none" | "sparse" | "partial" | "strong";
  priority: ResearchPriority;
  confidencePct: number;
  reasons: string[];
  summary: {
    totalNodes: number;
    totalTrees: number;
    completedNodes: number;
    completionPct: number;
    lastUpdatedAt: string | null;
    daysSinceUpdate: number | null;
    stale: boolean;
  };
  recommendedUsage: string;
}

function toIsoOrNull(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function computeLatestResearchTimestamp(nodes: ResearchNodeRecord[]): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const timestamps = [node.capturedAt, node.stateUpdatedAt, node.updatedAt]
      .map((value) => toIsoOrNull(value))
      .filter((value): value is string => value !== null);
    for (const timestamp of timestamps) {
      const ms = Date.parse(timestamp);
      if (!Number.isNaN(ms) && ms > latestMs) {
        latestMs = ms;
      }
    }
  }
  if (!Number.isFinite(latestMs)) {
    return null;
  }
  return new Date(latestMs).toISOString();
}

function parseJsonOrFallback<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeActiveEvent(raw: unknown): ActiveEventRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;

  const type = typeof record.type === "string" && record.type.trim()
    ? record.type.trim()
    : "general";
  const startTime = toIsoTimestamp(record.start_time ?? record.startTime ?? null);
  const endTime = toIsoTimestamp(record.end_time ?? record.endTime ?? null);
  const now = Date.now();
  const startsOk = !startTime || Date.parse(startTime) <= now;
  const endsOk = !endTime || Date.parse(endTime) > now;
  const scoring = record.scoring && typeof record.scoring === "object"
    ? record.scoring as Record<string, unknown>
    : {};

  return {
    name,
    type,
    scoring,
    startTime,
    endTime,
    isActive: startsOk && endsOk,
  };
}

function normalizeAwayTeam(raw: unknown): AwayTeamRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const officerId = typeof record.officer_id === "string"
    ? record.officer_id.trim()
    : typeof record.officerId === "string"
      ? record.officerId.trim()
      : "";
  const missionName = typeof record.mission_name === "string"
    ? record.mission_name.trim()
    : typeof record.missionName === "string"
      ? record.missionName.trim()
      : "";
  if (!officerId || !missionName) return null;

  const returnTime = toIsoTimestamp(record.return_time ?? record.returnTime ?? null);
  const isActive = returnTime ? Date.parse(returnTime) > Date.now() : true;

  return {
    officerId,
    missionName,
    returnTime,
    isActive,
  };
}

function resolveStoreAccess(reputation: number | null, tier: string | null): "locked" | "limited" | "open" {
  if (typeof tier === "string") {
    const normalized = tier.toLowerCase();
    if (["hostile", "enemy", "locked", "outlaw"].some((token) => normalized.includes(token))) {
      return "locked";
    }
    if (["ally", "admired", "celebrated", "champion", "trusted"].some((token) => normalized.includes(token))) {
      return "open";
    }
  }
  if (reputation == null) return "limited";
  if (reputation < 0) return "locked";
  if (reputation >= 10_000_000) return "open";
  return "limited";
}

function normalizeFactionStanding(raw: unknown): FactionStandingRecord[] {
  const rows: Array<{ faction: string; reputation: number | null; tier: string | null }> = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const faction = typeof record.faction === "string" ? record.faction.trim() : "";
      if (!faction) continue;
      const reputation = typeof record.reputation === "number" && Number.isFinite(record.reputation)
        ? record.reputation
        : null;
      const tier = typeof record.tier === "string" && record.tier.trim() ? record.tier.trim() : null;
      rows.push({ faction, reputation, tier });
    }
  } else if (raw && typeof raw === "object") {
    for (const [factionKey, value] of Object.entries(raw as Record<string, unknown>)) {
      const faction = factionKey.trim();
      if (!faction) continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        rows.push({ faction, reputation: value, tier: null });
        continue;
      }
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const reputation = typeof record.reputation === "number" && Number.isFinite(record.reputation)
          ? record.reputation
          : null;
        const tier = typeof record.tier === "string" && record.tier.trim() ? record.tier.trim() : null;
        rows.push({ faction, reputation, tier });
      }
    }
  }

  return rows.map((row) => ({
    ...row,
    storeAccess: resolveStoreAccess(row.reputation, row.tier),
  }));
}

async function readUserJsonSetting<T>(
  ctx: ToolContext,
  key: string,
  fallback: T,
): Promise<{ value: T; source: "user" | "system" | "env" | "default" | "unavailable" }> {
  if (!ctx.userSettingsStore || !ctx.userId) {
    return { value: fallback, source: "unavailable" };
  }
  const entry = await ctx.userSettingsStore.getForUser(ctx.userId, key);
  return {
    value: parseJsonOrFallback(entry.value, fallback),
    source: entry.source,
  };
}

async function getAwayTeamLocks(ctx: ToolContext): Promise<Array<AwayTeamRecord & { source: "settings" | "plan" }>> {
  const locks: Array<AwayTeamRecord & { source: "settings" | "plan" }> = [];

  const fromSettings = await readUserJsonSetting<unknown[]>(ctx, "fleet.awayTeams", []);
  for (const raw of fromSettings.value) {
    const normalized = normalizeAwayTeam(raw);
    if (!normalized || !normalized.isActive) continue;
    locks.push({ ...normalized, source: "settings" });
  }

  if (ctx.crewStore) {
    const planItems = await ctx.crewStore.listPlanItems();
    for (const item of planItems) {
      if (!item.isActive || !item.awayOfficers) continue;
      for (const officerId of item.awayOfficers) {
        if (!officerId) continue;
        locks.push({
          officerId,
          missionName: item.label || "Away Team Assignment",
          returnTime: null,
          isActive: true,
          source: "plan",
        });
      }
    }
  }

  return locks;
}

function calculateResearchAdvisory(nodes: ResearchNodeRecord[]): ResearchAdvisory {
  const totalNodes = nodes.length;
  const trees = new Set(nodes.map((node) => node.tree));
  const completedNodes = nodes.filter((node) => node.completed).length;
  const completionRatio = totalNodes > 0 ? completedNodes / totalNodes : 0;
  const completionPct = Math.round(completionRatio * 1000) / 10;
  const lastUpdatedAt = computeLatestResearchTimestamp(nodes);
  const daysSinceUpdate = lastUpdatedAt
    ? Math.round(((Date.now() - Date.parse(lastUpdatedAt)) / 86_400_000) * 10) / 10
    : null;
  const stale = daysSinceUpdate !== null && daysSinceUpdate > RESEARCH_STALE_DAYS;

  const reasons: string[] = [];
  if (totalNodes === 0) {
    reasons.push("no_research_data");
  }
  if (totalNodes > 0 && totalNodes < 10) {
    reasons.push("sparse_node_coverage");
  }
  if (trees.size > 0 && trees.size < 2) {
    reasons.push("limited_tree_coverage");
  }
  if (stale) {
    reasons.push("stale_snapshot");
  }

  const breadthScore = Math.min(1, totalNodes / 40);
  const completionScore = completionRatio;
  const freshnessScore = daysSinceUpdate === null ? 0.4 : Math.max(0, 1 - Math.max(0, daysSinceUpdate - 1) / 28);
  const confidencePct = Math.round((breadthScore * 0.6 + completionScore * 0.2 + freshnessScore * 0.2) * 100);

  if (totalNodes === 0) {
    return {
      status: "none",
      priority: "none",
      confidencePct: 0,
      reasons,
      summary: {
        totalNodes,
        totalTrees: trees.size,
        completedNodes,
        completionPct,
        lastUpdatedAt,
        daysSinceUpdate,
        stale,
      },
      recommendedUsage: "Research effects unavailable. Use base roster/ship context only.",
    };
  }

  let status: ResearchAdvisory["status"] = "partial";
  let priority: ResearchPriority = "medium";
  if (confidencePct < 45 || reasons.includes("sparse_node_coverage") || reasons.includes("limited_tree_coverage")) {
    status = "sparse";
    priority = "low";
  } else if (confidencePct >= 80 && !stale) {
    status = "strong";
  }

  return {
    status,
    priority,
    confidencePct,
    reasons,
    summary: {
      totalNodes,
      totalTrees: trees.size,
      completedNodes,
      completionPct,
      lastUpdatedAt,
      daysSinceUpdate,
      stale,
    },
    recommendedUsage:
      priority === "low"
        ? "Treat research bonuses as advisory only; prioritize base officer/ship fit."
        : "Research bonuses are reliable enough to influence tie-breakers and optimization.",
  };
}

function normalizePercentValue(value: number): number {
  if (Math.abs(value) > 1) {
    return value / 100;
  }
  return value;
}

function metricMatchesIntent(metric: string, intentKey: string | undefined): boolean {
  const normalized = metric.toLowerCase();
  const generic = ["attack", "weapon", "hull", "shield", "defense", "mitigation", "crit", "health", "officer"];
  const combat = ["pvp", "armada", "hostile", "combat", "damage", "impulse", "base"];
  const mining = ["mining", "cargo", "protected", "opc"];

  const matchesAny = (keywords: string[]) => keywords.some((keyword) => normalized.includes(keyword));

  if (!intentKey) {
    return matchesAny(generic) || matchesAny(combat);
  }

  if (intentKey.startsWith("mining")) {
    return matchesAny(generic) || matchesAny(mining);
  }

  return matchesAny(generic) || matchesAny(combat);
}

function extractRelevantBuffs(nodes: ResearchNodeRecord[], intentKey: string | undefined): Array<ResearchBuff & { nodeId: string; nodeName: string }> {
  const buffs: Array<ResearchBuff & { nodeId: string; nodeName: string }> = [];

  for (const node of nodes) {
    if (!node.completed && node.level <= 0) continue;
    for (const buff of node.buffs) {
      if (!metricMatchesIntent(buff.metric, intentKey)) continue;
      buffs.push({ ...buff, nodeId: node.nodeId, nodeName: node.name });
    }
  }

  return buffs;
}

function formatBuffValue(buff: ResearchBuff): string {
  if (buff.unit === "percent") {
    const percentValue = normalizePercentValue(buff.value) * 100;
    return percentValue % 1 === 0 ? `${percentValue}%` : `${percentValue.toFixed(1)}%`;
  }
  if (buff.unit === "multiplier") {
    return `${buff.value.toFixed(3)}x`;
  }
  return Number.isInteger(buff.value) ? String(buff.value) : buff.value.toFixed(2);
}

function buildResearchCitations(
  buffs: Array<ResearchBuff & { nodeId: string; nodeName: string }>,
  limit = 6,
): Array<{ nodeId: string; nodeName: string; metric: string; value: string; citation: string }> {
  return buffs.slice(0, limit).map((buff) => {
    const value = formatBuffValue(buff);
    const citation = `${buff.nodeName} (${buff.nodeId}) adds ${value} ${buff.metric}`;
    return {
      nodeId: buff.nodeId,
      nodeName: buff.nodeName,
      metric: buff.metric,
      value,
      citation,
    };
  });
}

interface UpgradeRequirement {
  key: string;
  resourceId: string | null;
  name: string;
  amount: number;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function extractBuildCostEntries(raw: unknown): UpgradeRequirement[] {
  if (!Array.isArray(raw)) return [];
  const requirements: UpgradeRequirement[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;

    const amount = toNumberOrNull(item.amount ?? item.value ?? item.quantity);
    if (amount == null || amount <= 0) continue;

    const idValue = item.resource_id ?? item.resourceId ?? item.id ?? item.type ?? null;
    const resourceId = idValue == null ? null : String(idValue);

    const name = typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : resourceId
        ? `resource:${resourceId}`
        : "unknown_resource";

    const key = normalizeToken(resourceId ?? name);
    requirements.push({ key, resourceId, name, amount });
  }

  return requirements;
}

function normalizeLookupDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return "";
  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  const domain = withoutProtocol.split("/")[0] ?? "";
  return domain.trim();
}

function normalizeLookupEntityType(entityType: string | undefined): "officer" | "ship" | "event" | "auto" {
  const normalized = (entityType ?? "auto").trim().toLowerCase();
  if (normalized === "officer" || normalized === "ship" || normalized === "event" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

function toPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function snapshotWebLookupMetrics(): Record<string, number> {
  return {
    requests: webLookupMetrics.requests,
    cacheHits: webLookupMetrics.cacheHits,
    cacheMisses: webLookupMetrics.cacheMisses,
    rateLimited: webLookupMetrics.rateLimited,
    robotsBlocked: webLookupMetrics.robotsBlocked,
    failures: webLookupMetrics.failures,
  };
}

function extractMetaDescription(html: string): string {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)
    ?? html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i);
  return toPlainText(match?.[1] ?? "").slice(0, 800);
}

function extractKeyValueRows(html: string): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  const regex = /<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
  let match = regex.exec(html);
  while (match) {
    const key = toPlainText(match[1] ?? "").trim();
    const value = toPlainText(match[2] ?? "").trim();
    if (key && value) rows.push({ key, value });
    match = regex.exec(html);
  }
  return rows;
}

function pickFact(rows: Array<{ key: string; value: string }>, keys: string[]): string | null {
  const normalizedKeys = keys.map((key) => key.toLowerCase());
  const found = rows.find((row) => normalizedKeys.some((key) => row.key.toLowerCase().includes(key)));
  return found?.value ?? null;
}

function detectEntityTypeFromPath(path: string, fallback: "officer" | "ship" | "event" | "auto"): "officer" | "ship" | "event" | "auto" {
  const normalized = path.toLowerCase();
  if (normalized.includes("/officers/")) return "officer";
  if (normalized.includes("/ships/")) return "ship";
  if (normalized.includes("/event")) return "event";
  return fallback;
}

function findStfcSpaceDetailPath(
  html: string,
  entityType: "officer" | "ship" | "event" | "auto",
): string | null {
  const candidates: string[] = [];
  const hrefRegex = /href=["'](\/[^"']+)["']/gi;
  let match = hrefRegex.exec(html);
  while (match) {
    const path = match[1] ?? "";
    if (!path.startsWith("/")) {
      match = hrefRegex.exec(html);
      continue;
    }
    if (path.startsWith("//") || path.startsWith("/search") || path.startsWith("/api")) {
      match = hrefRegex.exec(html);
      continue;
    }
    candidates.push(path);
    match = hrefRegex.exec(html);
  }

  if (entityType === "officer") {
    return candidates.find((path) => path.toLowerCase().includes("/officers/")) ?? null;
  }
  if (entityType === "ship") {
    return candidates.find((path) => path.toLowerCase().includes("/ships/")) ?? null;
  }
  if (entityType === "event") {
    return candidates.find((path) => path.toLowerCase().includes("/event")) ?? null;
  }

  return candidates.find((path) => /\/(officers|ships|events?)\//i.test(path)) ?? candidates[0] ?? null;
}

function checkWebLookupRateLimit(domain: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const events = (webLookupRateLimit.get(domain) ?? []).filter((ts) => now - ts < WEB_LOOKUP_RATE_LIMIT_WINDOW_MS);
  if (events.length >= WEB_LOOKUP_RATE_LIMIT_MAX) {
    const oldestInWindow = events[0] ?? now;
    return {
      allowed: false,
      retryAfterMs: Math.max(0, WEB_LOOKUP_RATE_LIMIT_WINDOW_MS - (now - oldestInWindow)),
    };
  }
  events.push(now);
  webLookupRateLimit.set(domain, events);
  return { allowed: true };
}

async function checkRobotsAllowed(domain: string): Promise<{ allowed: boolean; source: "cache" | "network"; reason?: string }> {
  const now = Date.now();
  const cached = robotsCache.get(domain);
  if (cached && now - cached.checkedAt < ROBOTS_CACHE_TTL_MS) {
    return {
      allowed: !cached.disallowAll,
      source: "cache",
      ...(cached.disallowAll ? { reason: "robots_disallow_all" } : {}),
    };
  }

  try {
    const response = await fetch(`https://${domain}/robots.txt`);
    if (!response.ok) {
      return { allowed: false, source: "network", reason: `robots_fetch_failed_${response.status}` };
    }
    const content = (await response.text()).toLowerCase();
    const disallowAll = /user-agent:\s*\*[\s\S]*?disallow:\s*\//m.test(content);
    robotsCache.set(domain, { checkedAt: now, disallowAll });
    return {
      allowed: !disallowAll,
      source: "network",
      ...(disallowAll ? { reason: "robots_disallow_all" } : {}),
    };
  } catch {
    return { allowed: false, source: "network", reason: "robots_unreachable" };
  }
}

async function lookupFandom(
  domain: string,
  query: string,
  entityType: "officer" | "ship" | "event" | "auto",
): Promise<object> {
  const url = new URL(`https://${domain}/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", query);

  const response = await fetch(url.toString());
  if (!response.ok) {
    return { error: `Lookup failed (${response.status}) for ${domain}` };
  }

  const payload = await response.json() as {
    query?: { pages?: Record<string, { pageid?: number; title?: string; extract?: string }> };
  };
  const pages = Object.values(payload.query?.pages ?? {});
  const first = pages.find((page) => (page.extract ?? "").trim().length > 0) ?? pages[0];
  if (!first) {
    return { error: `No results found for '${query}' on ${domain}` };
  }

  const summary = (first.extract ?? "").trim().slice(0, 800);
  return {
    source: domain,
    query,
    entityType,
    result: {
      title: first.title ?? query,
      pageId: first.pageid ?? null,
      summary,
      url: `https://${domain}/wiki/${encodeURIComponent((first.title ?? query).replace(/\s+/g, "_"))}`,
    },
  };
}

async function lookupStfcSpace(
  domain: string,
  query: string,
  entityType: "officer" | "ship" | "event" | "auto",
): Promise<object> {
  const response = await fetch(`https://${domain}/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    return { error: `Lookup failed (${response.status}) for ${domain}` };
  }

  const searchHtml = await response.text();
  const detailPath = findStfcSpaceDetailPath(searchHtml, entityType);
  if (!detailPath) {
    return {
      source: domain,
      query,
      entityType,
      result: {
        title: query,
        summary: "No structured result link found on search page.",
        url: `https://${domain}/search?q=${encodeURIComponent(query)}`,
      },
    };
  }

  const detailResponse = await fetch(`https://${domain}${detailPath}`);
  if (!detailResponse.ok) {
    return { error: `Lookup failed (${detailResponse.status}) for ${domain}${detailPath}` };
  }
  const detailHtml = await detailResponse.text();

  const titleMatch = detailHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
  const headingMatch = detailHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const fallbackSnippetMatch = detailHtml.match(/<p[^>]*>([\s\S]{40,600}?)<\/p>/i);
  const title = toPlainText(headingMatch?.[1] ?? titleMatch?.[1] ?? query).slice(0, 160);
  const summary = extractMetaDescription(detailHtml)
    || toPlainText(fallbackSnippetMatch?.[1] ?? "").slice(0, 800);
  const rows = extractKeyValueRows(detailHtml);
  const detectedEntityType = detectEntityTypeFromPath(detailPath, entityType);

  const common = {
    title,
    summary,
    url: `https://${domain}${detailPath}`,
  };

  if (detectedEntityType === "officer") {
    return {
      source: domain,
      query,
      entityType: detectedEntityType,
      result: {
        ...common,
        type: "officer",
        class: pickFact(rows, ["class", "officer class"]),
        rarity: pickFact(rows, ["rarity"]),
        faction: pickFact(rows, ["faction"]),
        group: pickFact(rows, ["group"]),
      },
    };
  }

  if (detectedEntityType === "ship") {
    return {
      source: domain,
      query,
      entityType: detectedEntityType,
      result: {
        ...common,
        type: "ship",
        hullType: pickFact(rows, ["hull", "hull type"]),
        rarity: pickFact(rows, ["rarity"]),
        faction: pickFact(rows, ["faction"]),
        grade: pickFact(rows, ["grade"]),
      },
    };
  }

  return {
    source: domain,
    query,
    entityType: detectedEntityType,
    result: {
      ...common,
      type: detectedEntityType,
    },
  };
}

export async function webLookup(
  domainInput: string,
  queryInput: string,
  entityTypeInput: string | undefined,
): Promise<object> {
  webLookupMetrics.requests += 1;

  const domain = normalizeLookupDomain(domainInput);
  const query = queryInput.trim();
  const entityType = normalizeLookupEntityType(entityTypeInput);

  if (!domain) {
    return { error: "domain is required." };
  }
  if (!WEB_LOOKUP_ALLOWLIST.has(domain)) {
    return { error: `Domain '${domain}' is not allowlisted.` };
  }
  if (!query) {
    return { error: "query is required." };
  }

  const cacheKey = `${domain}|${entityType}|${query.toLowerCase()}`;
  const cached = webLookupCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    webLookupMetrics.cacheHits += 1;
    log.fleet.debug({ domain, query, entityType, cacheHit: true }, "web_lookup cache hit");
    return {
      tool: "web_lookup",
      cache: { hit: true, ttlMs: cached.expiresAt - Date.now() },
      observability: snapshotWebLookupMetrics(),
      ...cached.payload,
    };
  }
  webLookupMetrics.cacheMisses += 1;

  const rate = checkWebLookupRateLimit(domain);
  if (!rate.allowed) {
    webLookupMetrics.rateLimited += 1;
    log.fleet.warn({ domain, query, retryAfterMs: rate.retryAfterMs ?? 0 }, "web_lookup rate limited");
    return {
      error: `Rate limit exceeded for ${domain}.`,
      retryAfterMs: rate.retryAfterMs ?? 0,
      observability: snapshotWebLookupMetrics(),
    };
  }

  const robots = await checkRobotsAllowed(domain);
  if (!robots.allowed) {
    webLookupMetrics.robotsBlocked += 1;
    log.fleet.warn({ domain, query, reason: robots.reason ?? "blocked" }, "web_lookup blocked by robots");
    return {
      error: `robots.txt policy blocks lookup for ${domain}.`,
      robots,
      observability: snapshotWebLookupMetrics(),
    };
  }

  const payload = domain.endsWith("fandom.com")
    ? await lookupFandom(domain, query, entityType)
    : await lookupStfcSpace(domain, query, entityType);

  const result = {
    tool: "web_lookup",
    cache: { hit: false, ttlMs: WEB_LOOKUP_CACHE_TTL_MS },
    robots,
    observability: snapshotWebLookupMetrics(),
    ...payload,
  };

  if (!("error" in result)) {
    webLookupCache.set(cacheKey, {
      expiresAt: Date.now() + WEB_LOOKUP_CACHE_TTL_MS,
      payload,
    });
    log.fleet.debug({ domain, query, entityType, cacheHit: false }, "web_lookup cache miss resolved");
  } else {
    webLookupMetrics.failures += 1;
    log.fleet.warn({ domain, query, entityType, error: (result as { error?: string }).error }, "web_lookup failed");
  }

  return result;
}

function aggregateRequirements(entries: UpgradeRequirement[]): UpgradeRequirement[] {
  const totals = new Map<string, UpgradeRequirement>();
  for (const entry of entries) {
    const existing = totals.get(entry.key);
    if (!existing) {
      totals.set(entry.key, { ...entry });
      continue;
    }
    existing.amount += entry.amount;
  }
  return Array.from(totals.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function extractTierRequirements(
  tiers: Record<string, unknown>[] | null,
  fromTierExclusive: number,
  toTierInclusive: number,
): UpgradeRequirement[] {
  if (!tiers || tiers.length === 0) return [];

  const requirements: UpgradeRequirement[] = [];
  for (const tierEntry of tiers) {
    const tierValue = toNumberOrNull((tierEntry as Record<string, unknown>).tier);
    if (tierValue == null) continue;
    if (tierValue <= fromTierExclusive || tierValue > toTierInclusive) continue;

    const components = (tierEntry as Record<string, unknown>).components;
    if (!Array.isArray(components)) continue;

    for (const component of components) {
      if (!component || typeof component !== "object") continue;
      const buildCost = (component as Record<string, unknown>).build_cost
        ?? (component as Record<string, unknown>).buildCost;
      requirements.push(...extractBuildCostEntries(buildCost));
    }
  }

  return aggregateRequirements(requirements);
}

// ─── Phase 1: Core Read Tools ───────────────────────────────

export async function getFleetOverview(ctx: ToolContext): Promise<object> {
  const overview: Record<string, unknown> = {};

  if (ctx.referenceStore) {
    const refCounts = await ctx.referenceStore.counts();
    overview.referenceCatalog = {
      officers: refCounts.officers,
      ships: refCounts.ships,
    };
  }

  if (ctx.overlayStore) {
    const overlayCounts = await ctx.overlayStore.counts();
    overview.overlays = {
      officers: overlayCounts.officers,
      ships: overlayCounts.ships,
    };
  }

  if (ctx.crewStore) {
    const [loadouts, docks, planItems, bridgeCores, presets, reservations] = await Promise.all([
      ctx.crewStore.listLoadouts(),
      ctx.crewStore.listDocks(),
      ctx.crewStore.listPlanItems(),
      ctx.crewStore.listBridgeCores(),
      ctx.crewStore.listFleetPresets(),
      ctx.crewStore.listReservations(),
    ]);
    const activePreset = presets.find((p) => p.isActive);
    overview.crew = {
      loadouts: loadouts.length,
      docks: docks.length,
      planItems: planItems.length,
      bridgeCores: bridgeCores.length,
      fleetPresets: presets.length,
      activePreset: activePreset ? { id: activePreset.id, name: activePreset.name } : null,
      reservations: reservations.length,
      lockedReservations: reservations.filter((r) => r.locked).length,
    };
  }

  return overview;
}

export async function searchOfficers(query: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }
  if (!query.trim()) {
    return { error: "Search query is required." };
  }

  const officers = await ctx.referenceStore.searchOfficers(query);
  // Fetch reservations if crew store is available
  const reservations = ctx.crewStore ? await ctx.crewStore.listReservations() : [];
  const reservationMap = new Map(reservations.map((r) => [r.officerId, r]));

  const results = officers.slice(0, SEARCH_LIMIT).map((o) => {
    const res = reservationMap.get(o.id);
    return {
      id: o.id,
      name: o.name,
      rarity: o.rarity,
      group: o.groupName,
      officerClass: officerClassLabel(o.officerClass),
      captainManeuver: o.captainManeuver,
      officerAbility: o.officerAbility,
      ...(o.faction ? { faction: (o.faction as Record<string, unknown>).name ?? null } : {}),
      ...(res ? { reservation: { reservedFor: res.reservedFor, locked: res.locked } } : {}),
    };
  });

  return {
    results,
    totalFound: officers.length,
    truncated: officers.length > SEARCH_LIMIT,
  };
}

export async function searchShips(query: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }
  if (!query.trim()) {
    return { error: "Search query is required." };
  }

  const ships = await ctx.referenceStore.searchShips(query);
  const results = ships.slice(0, SEARCH_LIMIT).map((s) => ({
    id: s.id,
    name: s.name,
    shipClass: s.shipClass,
    grade: s.grade,
    rarity: s.rarity,
    faction: s.faction,
    tier: s.tier,
    hullType: hullTypeLabel(s.hullType),
    maxTier: s.maxTier,
  }));

  return {
    results,
    totalFound: ships.length,
    truncated: ships.length > SEARCH_LIMIT,
  };
}

export async function getOfficerDetail(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  const officer = await ctx.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  const result: Record<string, unknown> = {
    reference: {
      id: officer.id,
      name: officer.name,
      rarity: officer.rarity,
      group: officer.groupName,
      officerClass: officerClassLabel(officer.officerClass),
      faction: officer.faction ? (officer.faction as Record<string, unknown>).name ?? null : null,
      captainManeuver: officer.captainManeuver,
      officerAbility: officer.officerAbility,
      belowDeckAbility: officer.belowDeckAbility,
      maxRank: officer.maxRank,
      synergyId: officer.synergyId,
      abilities: officer.abilities,
      traitConfig: officer.traitConfig,
      source: officer.source,
    },
  };

  // Merge overlay if available
  if (ctx.overlayStore) {
    const overlay = await ctx.overlayStore.getOfficerOverlay(officerId);
    if (overlay) {
      result.overlay = {
        ownershipState: overlay.ownershipState,
        target: overlay.target,
        level: overlay.level,
        rank: overlay.rank,
        power: overlay.power,
        targetNote: overlay.targetNote,
        targetPriority: overlay.targetPriority,
      };
    }
  }

  return result;
}

export async function getShipDetail(shipId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  const result: Record<string, unknown> = {
    reference: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      grade: ship.grade,
      rarity: ship.rarity,
      faction: ship.faction,
      tier: ship.tier,
      hullType: hullTypeLabel(ship.hullType),
      maxTier: ship.maxTier,
      maxLevel: ship.maxLevel,
      blueprintsRequired: ship.blueprintsRequired,
      buildRequirements: ship.buildRequirements,
      tiers: ship.tiers,
      buildTimeInSeconds: ship.buildTimeInSeconds,
      officerBonus: ship.officerBonus,
      crewSlots: ship.crewSlots,
      ability: ship.ability,
      source: ship.source,
    },
  };

  // Merge overlay if available
  if (ctx.overlayStore) {
    const overlay = await ctx.overlayStore.getShipOverlay(shipId);
    if (overlay) {
      result.overlay = {
        ownershipState: overlay.ownershipState,
        target: overlay.target,
        tier: overlay.tier,
        level: overlay.level,
        power: overlay.power,
        targetNote: overlay.targetNote,
        targetPriority: overlay.targetPriority,
      };
    }
  }

  return result;
}

export async function listDocks(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.crewStore.getEffectiveDockState();
  const results = state.docks.map((d) => ({
    dockNumber: d.dockNumber,
    intentKeys: d.intentKeys,
    source: d.source,
    variantPatch: d.variantPatch,
    assignment: d.loadout
      ? {
          loadoutId: d.loadout.loadoutId,
          loadoutName: d.loadout.name,
          shipId: d.loadout.shipId,
          bridge: d.loadout.bridge,
          belowDeckPolicy: d.loadout.belowDeckPolicy
            ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
            : null,
        }
      : null,
  }));

  return { docks: results };
}

export async function getOfficerConflicts(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.crewStore.getEffectiveDockState();
  return {
    conflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.map((loc) => ({
        type: loc.type,
        entityId: loc.entityId,
        entityName: loc.entityName,
        slot: loc.slot,
      })),
    })),
    totalConflicts: state.conflicts.length,
  };
}

export async function validatePlan(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.crewStore.getEffectiveDockState();
  const planItems = await ctx.crewStore.listPlanItems({ active: true });

  const emptyDocks = state.docks.filter((d) => !d.loadout);
  const unassignedPlanItems = planItems.filter((p) => p.dockNumber == null && !p.awayOfficers?.length);

  return {
    valid: state.conflicts.length === 0 && unassignedPlanItems.length === 0,
    officerConflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.length,
    })),
    emptyDocks: emptyDocks.map((d) => d.dockNumber),
    unassignedPlanItems: unassignedPlanItems.map((p) => ({
      planItemId: p.id,
      label: p.label,
    })),
    totalDocks: state.docks.length,
    totalPlanItems: planItems.length,
    totalConflicts: state.conflicts.length,
  };
}

// ─── Phase 2: Crew Composition Implementations ──────────────

export async function listOwnedOfficers(ctx: ToolContext): Promise<object> {
  if (!ctx.overlayStore) {
    return { error: "Overlay system not available. The Admiral may need to set up ownership data first." };
  }
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }

  const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });

  // Batch-fetch all reference officers (avoids N+1 per overlay)
  const allOfficers = await ctx.referenceStore.listOfficers();
  const refMap = new Map(allOfficers.map(o => [o.id, o]));

  const officers = overlays.map((overlay) => {
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
      power: overlay.power,
    };
  });

  const results = officers.filter(Boolean);
  return {
    officers: results,
    totalOwned: results.length,
  };
}

export async function getLoadoutDetail(loadoutId: number, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!loadoutId || isNaN(loadoutId)) {
    return { error: "Valid loadout ID is required." };
  }

  const loadout = await ctx.crewStore.getLoadout(loadoutId);
  if (!loadout) {
    return { error: `Loadout not found: ${loadoutId}` };
  }

  const variants = await ctx.crewStore.listVariants(loadoutId);

  return {
    id: loadout.id,
    name: loadout.name,
    shipId: loadout.shipId,
    priority: loadout.priority,
    isActive: loadout.isActive,
    intentKeys: loadout.intentKeys,
    tags: loadout.tags,
    notes: loadout.notes,
    bridgeCore: loadout.bridgeCore
      ? {
          id: loadout.bridgeCore.id,
          name: loadout.bridgeCore.name,
          members: loadout.bridgeCore.members.map((m) => ({
            officerId: m.officerId,
            slot: m.slot,
          })),
        }
      : null,
    belowDeckPolicy: loadout.belowDeckPolicy
      ? {
          id: loadout.belowDeckPolicy.id,
          name: loadout.belowDeckPolicy.name,
          mode: loadout.belowDeckPolicy.mode,
          spec: loadout.belowDeckPolicy.spec,
        }
      : null,
    variants: variants.map((v) => ({
      id: v.id,
      name: v.name,
      patch: v.patch,
      notes: v.notes,
    })),
  };
}

export async function listPlanItems(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const items = await ctx.crewStore.listPlanItems();
  return {
    planItems: items.map((p) => ({
      id: p.id,
      label: p.label,
      intentKey: p.intentKey,
      dockNumber: p.dockNumber,
      loadoutId: p.loadoutId,
      variantId: p.variantId,
      priority: p.priority,
      isActive: p.isActive,
      source: p.source,
      awayOfficers: p.awayOfficers,
    })),
    totalItems: items.length,
  };
}

export async function listIntents(category: string | undefined, _ctx: ToolContext): Promise<object> {
  let intents = SEED_INTENTS;
  if (category) {
    intents = intents.filter((i: SeedIntent) => i.category === category);
  }
  return {
    intents: intents.map((i: SeedIntent) => ({
      key: i.key,
      label: i.label,
      category: i.category,
      description: i.description,
      icon: i.icon,
    })),
    totalIntents: intents.length,
  };
}

export async function listResearch(
  tree: string | undefined,
  includeCompleted: boolean | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.researchStore) {
    return { error: "Research store not available. Sync research data first." };
  }

  const result = await ctx.researchStore.listByTree({
    tree: tree?.trim() || undefined,
    includeCompleted: includeCompleted ?? true,
  });
  const counts = await ctx.researchStore.counts();

  return {
    trees: result,
    summary: {
      totalTrees: result.length,
      totalNodes: counts.nodes,
      totalCompleted: counts.completed,
      treeFilter: tree?.trim() || null,
      includeCompleted: includeCompleted ?? true,
    },
  };
}

export async function listInventory(
  category: string | undefined,
  query: string | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.inventoryStore) {
    return { error: "Inventory store not available." };
  }

  const normalizedCategory = category?.trim().toLowerCase() as InventoryCategory | undefined;
  const categories = new Set(["ore", "gas", "crystal", "parts", "currency", "blueprint", "other"]);
  if (normalizedCategory && !categories.has(normalizedCategory)) {
    return { error: `Invalid category '${category}'.` };
  }

  const grouped = await ctx.inventoryStore.listByCategory({
    category: normalizedCategory,
    q: query?.trim() || undefined,
  });
  const counts = await ctx.inventoryStore.counts();

  return {
    categories: grouped,
    summary: {
      totalItems: counts.items,
      totalCategories: counts.categories,
      activeCategoryFilter: normalizedCategory ?? null,
      query: query?.trim() || null,
    },
  };
}

export async function listActiveEvents(ctx: ToolContext): Promise<object> {
  const eventsData = await readUserJsonSetting<unknown[]>(ctx, "fleet.activeEvents", []);
  const events = eventsData.value
    .map((row) => normalizeActiveEvent(row))
    .filter((row): row is ActiveEventRecord => row !== null)
    .sort((left, right) => {
      const leftStart = left.startTime ? Date.parse(left.startTime) : Number.POSITIVE_INFINITY;
      const rightStart = right.startTime ? Date.parse(right.startTime) : Number.POSITIVE_INFINITY;
      return leftStart - rightStart;
    });

  return {
    events,
    totalEvents: events.length,
    totalActiveEvents: events.filter((event) => event.isActive).length,
    source: eventsData.source,
    note: eventsData.source === "unavailable"
      ? "User settings store unavailable; returning empty event context."
      : undefined,
  };
}

export async function listAwayTeams(ctx: ToolContext): Promise<object> {
  const locks = await getAwayTeamLocks(ctx);

  return {
    awayTeams: locks.map((entry) => ({
      officer_id: entry.officerId,
      mission_name: entry.missionName,
      return_time: entry.returnTime,
      source: entry.source,
    })),
    lockedOfficerIds: Array.from(new Set(locks.map((entry) => entry.officerId))).sort(),
    totalAssignments: locks.length,
  };
}

export async function getFactionStanding(
  faction: string | undefined,
  ctx: ToolContext,
): Promise<object> {
  const standingsData = await readUserJsonSetting<unknown>(ctx, "fleet.factionStandings", {});
  let standings = normalizeFactionStanding(standingsData.value);

  const filter = faction?.trim().toLowerCase();
  if (filter) {
    standings = standings.filter((row) => row.faction.toLowerCase().includes(filter));
  }

  return {
    standings,
    totalStandings: standings.length,
    source: standingsData.source,
  };
}

export async function calculateUpgradePath(
  shipId: string,
  targetTier: number | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!ctx.inventoryStore) {
    return { error: "Inventory store not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  const overlay = ctx.overlayStore ? await ctx.overlayStore.getShipOverlay(shipId) : null;
  const currentTier = overlay?.tier ?? ship.tier ?? 0;
  const maxTier = ship.maxTier ?? 15;
  const resolvedTargetTier = targetTier == null ? currentTier + 1 : targetTier;

  if (!Number.isInteger(resolvedTargetTier) || resolvedTargetTier < 1) {
    return { error: "target_tier must be a positive integer." };
  }
  if (resolvedTargetTier > maxTier) {
    return { error: `target_tier exceeds ship max tier (${maxTier}).` };
  }
  if (resolvedTargetTier <= currentTier) {
    return { error: `target_tier (${resolvedTargetTier}) must be above current tier (${currentTier}).` };
  }

  const tierRequirements = extractTierRequirements(ship.tiers, currentTier, resolvedTargetTier);

  const allInventoryItems = await ctx.inventoryStore.listItems();
  const inventoryByKey = new Map<string, number>();
  for (const item of allInventoryItems) {
    const key = normalizeToken(item.name);
    inventoryByKey.set(key, (inventoryByKey.get(key) ?? 0) + item.quantity);
  }

  const requirementRows = tierRequirements.map((requirement) => {
    const inventoryMatchQty =
      inventoryByKey.get(normalizeToken(requirement.name))
      ?? (requirement.resourceId ? inventoryByKey.get(normalizeToken(requirement.resourceId)) : undefined)
      ?? 0;
    const required = Math.round(requirement.amount);
    const available = Math.max(0, Math.round(inventoryMatchQty));
    const gap = Math.max(0, required - available);
    return {
      key: requirement.key,
      name: requirement.name,
      resourceId: requirement.resourceId,
      required,
      available,
      gap,
      ready: gap === 0,
    };
  });

  const totalRequired = requirementRows.reduce((sum, row) => sum + row.required, 0);
  const totalAvailable = requirementRows.reduce((sum, row) => sum + Math.min(row.required, row.available), 0);
  const totalGap = requirementRows.reduce((sum, row) => sum + row.gap, 0);
  const coveragePct = totalRequired === 0 ? 0 : Math.round((totalAvailable / totalRequired) * 100);

  return {
    ship: {
      id: ship.id,
      name: ship.name,
      currentTier,
      targetTier: resolvedTargetTier,
      maxTier,
      rarity: ship.rarity,
      shipClass: ship.shipClass,
    },
    requirements: requirementRows,
    summary: {
      requirementCount: requirementRows.length,
      totalRequired,
      totalAvailable,
      totalGap,
      coveragePct,
      fullyReady: totalGap === 0 && requirementRows.length > 0,
    },
    assumptions: [
      "Upgrade path uses available ship tier component build_cost data.",
      "Inventory matching uses normalized resource names/IDs and may miss unmapped resources.",
    ],
  };
}

function inferDefaultDailyRate(requirementName: string): number {
  const normalized = requirementName.toLowerCase();
  if (normalized.includes("ore")) return 120;
  if (normalized.includes("gas")) return 100;
  if (normalized.includes("crystal")) return 80;
  if (normalized.includes("part")) return 40;
  if (normalized.includes("blueprint")) return 8;
  if (normalized.includes("latinum") || normalized.includes("credit")) return 60;
  return 50;
}

function resolveOverrideDailyRate(
  requirementName: string,
  resourceId: string | null,
  overrides: Map<string, number>,
): number | undefined {
  const requirementKey = normalizeToken(requirementName);
  const direct = overrides.get(requirementKey);
  if (direct != null) return direct;

  if (resourceId) {
    const byId = overrides.get(normalizeToken(resourceId));
    if (byId != null) return byId;
  }

  for (const [key, value] of overrides.entries()) {
    if (requirementKey.includes(key) || key.includes(requirementKey)) {
      return value;
    }
  }

  return undefined;
}

export async function estimateAcquisitionTime(
  shipId: string,
  targetTier: number | undefined,
  dailyIncome: Record<string, unknown> | undefined,
  ctx: ToolContext,
): Promise<object> {
  const upgradeResult = await calculateUpgradePath(shipId, targetTier, ctx) as Record<string, unknown>;
  if (upgradeResult.error) {
    return upgradeResult;
  }

  const requirements = (upgradeResult.requirements as Array<Record<string, unknown>> | undefined) ?? [];
  const overrideEntries = Object.entries(dailyIncome ?? {})
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .map(([key, value]) => [normalizeToken(key), Number(value)] as const);
  const overrides = new Map<string, number>(overrideEntries);

  const perResource = requirements
    .filter((entry) => Number(entry.gap ?? 0) > 0)
    .map((entry) => {
      const name = String(entry.name ?? "unknown_resource");
      const resourceId = entry.resourceId == null ? null : String(entry.resourceId);

      const dailyRate =
        resolveOverrideDailyRate(name, resourceId, overrides)
        ?? inferDefaultDailyRate(name);

      const gap = Number(entry.gap ?? 0);
      const days = dailyRate > 0 ? Math.ceil((gap / dailyRate) * 10) / 10 : null;

      return {
        name,
        resourceId,
        gap,
        dailyRate,
        days,
        blocked: days === null,
      };
    })
    .sort((left, right) => right.gap - left.gap);

  const blocking = perResource.filter((entry) => entry.blocked);
  const nonBlocked = perResource.filter((entry) => !entry.blocked && entry.days != null);
  const estimatedDays = nonBlocked.length > 0 ? Math.max(...nonBlocked.map((entry) => Number(entry.days))) : null;

  return {
    ship: upgradeResult.ship,
    target: {
      targetTier: (upgradeResult.ship as Record<string, unknown>).targetTier,
    },
    perResource,
    summary: {
      resourcesWithGap: perResource.length,
      blockingResources: blocking.length,
      estimatedDays,
      feasible: blocking.length === 0 && estimatedDays !== null,
      overrideCount: overrides.size,
    },
    assumptions: [
      "Uses calculate_upgrade_path gap output as baseline.",
      "Daily rates default by resource keyword unless overridden in daily_income.",
    ],
  };
}

export async function calculateTruePower(
  shipId: string,
  intentKey: string | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  const overlay = ctx.overlayStore ? await ctx.overlayStore.getShipOverlay(shipId) : null;
  const basePower = overlay?.power ?? null;

  const nodes = ctx.researchStore ? await ctx.researchStore.listNodes() : [];
  const researchAdvisory = calculateResearchAdvisory(nodes);
  const relevantBuffs = extractRelevantBuffs(nodes, intentKey);

  let multiplierPct = 0;
  let flatBonus = 0;
  for (const buff of relevantBuffs) {
    if (buff.unit === "percent") {
      multiplierPct += normalizePercentValue(buff.value) * 100;
      continue;
    }
    if (buff.unit === "multiplier") {
      multiplierPct += (buff.value - 1) * 100;
      continue;
    }
    if (buff.unit === "flat") {
      flatBonus += buff.value;
    }
  }

  const effectiveMultiplier = 1 + multiplierPct / 100;
  const calculatedPower =
    basePower === null
      ? null
      : Math.max(0, Math.round(basePower * effectiveMultiplier + flatBonus));

  const assumptions: string[] = [];
  if (basePower === null) {
    assumptions.push("ship_overlay_power_missing");
  }
  if (!ctx.researchStore) {
    assumptions.push("research_store_unavailable");
  }
  if (researchAdvisory.priority === "low") {
    assumptions.push("research_low_confidence_advisory_only");
  }

  return {
    ship: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      hullType: hullTypeLabel(ship.hullType),
      rarity: ship.rarity,
      tier: ship.tier,
    },
    intentKey: intentKey ?? null,
    basePower,
    calculatedPower,
    researchImpact: {
      relevantBuffs: relevantBuffs.length,
      multiplierPct: Math.round(multiplierPct * 100) / 100,
      flatBonus: Math.round(flatBonus * 100) / 100,
      effectiveMultiplier: Math.round(effectiveMultiplier * 10000) / 10000,
      sampleBuffs: relevantBuffs.slice(0, 8).map((buff) => ({
        nodeId: buff.nodeId,
        nodeName: buff.nodeName,
        metric: buff.metric,
        value: buff.value,
        unit: buff.unit,
      })),
    },
    researchAdvisory,
    assumptions,
  };
}

export async function findLoadoutsForIntent(intentKey: string, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!intentKey.trim()) {
    return { error: "Intent key is required." };
  }

  const loadouts = await ctx.crewStore.listLoadouts({ intentKey });
  const detailed = await Promise.all(
    loadouts.map(async (l) => {
      const full = await ctx.crewStore!.getLoadout(l.id);
      return {
        id: l.id,
        name: l.name,
        shipId: l.shipId,
        isActive: l.isActive,
        bridgeCore: full?.bridgeCore
          ? {
              name: full.bridgeCore.name,
              members: full.bridgeCore.members.map((m) => ({
                officerId: m.officerId,
                slot: m.slot,
              })),
            }
          : null,
      };
    }),
  );

  return {
    intentKey,
    loadouts: detailed,
    totalLoadouts: detailed.length,
  };
}

export async function suggestCrew(
  shipId: string,
  intentKey: string | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  let intent: { key: string; label: string; category: string; description: string | null } | null = null;
  if (intentKey) {
    const match = SEED_INTENTS.find((i: SeedIntent) => i.key === intentKey);
    if (match) {
      intent = {
        key: match.key,
        label: match.label,
        category: match.category,
        description: match.description,
      };
    }
  }

  const unavailableOfficerReasons = new Map<string, string[]>();
  const awayTeamLocks = await getAwayTeamLocks(ctx);
  for (const assignment of awayTeamLocks) {
    const reasons = unavailableOfficerReasons.get(assignment.officerId) ?? [];
    reasons.push("away_team");
    unavailableOfficerReasons.set(assignment.officerId, reasons);
  }
  if (ctx.crewStore) {
    const reservations = await ctx.crewStore.listReservations();
    for (const reservation of reservations) {
      if (!reservation.locked) continue;
      const reasons = unavailableOfficerReasons.get(reservation.officerId) ?? [];
      reasons.push("reservation_locked");
      unavailableOfficerReasons.set(reservation.officerId, reasons);
    }
  }

  const ownedOfficers: Array<Record<string, unknown>> = [];
  const excludedOfficers: Array<Record<string, unknown>> = [];
  if (ctx.overlayStore) {
    const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
    const allOfficers = await ctx.referenceStore.listOfficers();
    const refMap = new Map(allOfficers.map(o => [o.id, o]));
    for (const overlay of overlays) {
      const ref = refMap.get(overlay.refId);
      if (!ref) continue;
      const reasons = unavailableOfficerReasons.get(ref.id) ?? [];
      if (reasons.length > 0) {
        excludedOfficers.push({
          id: ref.id,
          name: ref.name,
          reasons: Array.from(new Set(reasons)).sort(),
        });
        continue;
      }
      ownedOfficers.push({
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
      });
    }
  }

  const existingLoadouts: Array<Record<string, unknown>> = [];
  if (ctx.crewStore) {
    const loadouts = await ctx.crewStore.listLoadouts({ shipId });
    const loadoutIds = loadouts.map(l => l.id);
    const fullMap = await ctx.crewStore.getLoadoutsByIds(loadoutIds);
    for (const l of loadouts) {
      const full = fullMap.get(l.id);
      existingLoadouts.push({
        id: l.id,
        name: l.name,
        isActive: l.isActive,
        intentKeys: l.intentKeys,
        bridgeCore: full?.bridgeCore
          ? full.bridgeCore.members.map((m) => ({
              officerId: m.officerId,
              slot: m.slot,
            }))
          : [],
      });
    }
  }

  const researchNodes = ctx.researchStore ? await ctx.researchStore.listNodes() : [];
  const researchAdvisory = calculateResearchAdvisory(researchNodes);
  const relevantResearchBuffs = extractRelevantBuffs(researchNodes, intentKey);
  const researchCitations = buildResearchCitations(relevantResearchBuffs);

  return {
    ship: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      grade: ship.grade,
      rarity: ship.rarity,
      faction: ship.faction,
      hullType: hullTypeLabel(ship.hullType),
      maxTier: ship.maxTier,
      officerBonus: ship.officerBonus,
      crewSlots: ship.crewSlots,
    },
    intent,
    ownedOfficers,
    excludedOfficers,
    existingLoadouts,
    totalOwnedOfficers: ownedOfficers.length,
    totalExcludedOfficers: excludedOfficers.length,
    researchContext: {
      ...researchAdvisory,
      relevantBuffCount: relevantResearchBuffs.length,
      citations: researchCitations,
      note:
        researchAdvisory.priority === "low"
          ? "Research data is sparse/stale; use only as a secondary signal."
          : "Research data coverage is sufficient to refine recommendations.",
    },
    recommendationHints: {
      prioritizeBaseFit: researchAdvisory.priority !== "medium",
      useResearchAsTiebreaker: researchAdvisory.priority === "low",
      useResearchInCoreScoring: researchAdvisory.priority === "medium",
      citationRequirement:
        researchCitations.length > 0
          ? "When referencing research in rationale, cite by nodeName + nodeId from researchContext.citations."
          : "No research citations available; avoid claiming specific research bonuses.",
    },
  };
}

export async function analyzeFleet(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const [effectiveState, planItems, loadouts, presets, reservations] = await Promise.all([
    ctx.crewStore.getEffectiveDockState(),
    ctx.crewStore.listPlanItems(),
    ctx.crewStore.listLoadouts(),
    ctx.crewStore.listFleetPresets(),
    ctx.crewStore.listReservations(),
  ]);

  const activePreset = presets.find((p) => p.isActive);

  return {
    activePreset: activePreset ? { id: activePreset.id, name: activePreset.name, slots: activePreset.slots.length } : null,
    docks: effectiveState.docks.map((d) => ({
      dockNumber: d.dockNumber,
      source: d.source,
      intentKeys: d.intentKeys,
      variantPatch: d.variantPatch,
      assignment: d.loadout
        ? {
            loadoutId: d.loadout.loadoutId,
            loadoutName: d.loadout.name,
            shipId: d.loadout.shipId,
            bridge: d.loadout.bridge,
            belowDeckPolicy: d.loadout.belowDeckPolicy
              ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
              : null,
          }
        : null,
    })),
    loadouts: loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      shipId: l.shipId,
      isActive: l.isActive,
      intentKeys: l.intentKeys,
    })),
    planItems: planItems.map((p) => ({
      id: p.id,
      label: p.label,
      intentKey: p.intentKey,
      dockNumber: p.dockNumber,
      loadoutId: p.loadoutId,
      isActive: p.isActive,
      source: p.source,
    })),
    awayTeams: effectiveState.awayTeams.map((a) => ({
      label: a.label,
      officers: a.officers,
      source: a.source,
    })),
    conflicts: effectiveState.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.map((loc) => loc.entityName),
      locationCount: c.locations.length,
    })),
    totalDocks: effectiveState.docks.length,
    totalLoadouts: loadouts.length,
    totalPlanItems: planItems.length,
    totalConflicts: effectiveState.conflicts.length,
    reservations: reservations.map((r) => ({
      officerId: r.officerId,
      reservedFor: r.reservedFor,
      locked: r.locked,
    })),
    totalReservations: reservations.length,
  };
}

export async function resolveConflict(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  const officer = await ctx.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  const reservation = await ctx.crewStore.getReservation(officerId);

  const state = await ctx.crewStore.getEffectiveDockState();
  const conflict = state.conflicts.find((c) => c.officerId === officerId) ?? null;

  const alternatives: Array<Record<string, unknown>> = [];
  if (officer.groupName) {
    const groupOfficers = await ctx.referenceStore.listOfficers({ groupName: officer.groupName });
    const altIds = groupOfficers.filter(a => a.id !== officerId).map(a => a.id);
    const overlayMap = new Map<string, boolean>();
    if (ctx.overlayStore && altIds.length > 0) {
      const ownedOverlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
      const ownedSet = new Set(ownedOverlays.map(o => o.refId));
      for (const id of altIds) overlayMap.set(id, ownedSet.has(id));
    }
    for (const alt of groupOfficers) {
      if (alt.id === officerId) continue;
      alternatives.push({
        id: alt.id,
        name: alt.name,
        rarity: alt.rarity,
        group: alt.groupName,
        officerClass: officerClassLabel(alt.officerClass),
        faction: alt.faction ? (alt.faction as Record<string, unknown>).name ?? null : null,
        captainManeuver: alt.captainManeuver,
        officerAbility: alt.officerAbility,
        belowDeckAbility: alt.belowDeckAbility,
        owned: overlayMap.get(alt.id) ?? false,
      });
    }
  }

  const loadouts = await ctx.crewStore.listLoadouts();
  const loadoutIds = loadouts.map(l => l.id);
  const fullMap = await ctx.crewStore.getLoadoutsByIds(loadoutIds);
  const affectedLoadouts: Array<Record<string, unknown>> = [];
  for (const l of loadouts) {
    const full = fullMap.get(l.id);
    if (full?.bridgeCore?.members.some((m) => m.officerId === officerId)) {
      affectedLoadouts.push({
        loadoutId: l.id,
        loadoutName: l.name,
        shipId: l.shipId,
      });
    }
  }

  return {
    officer: {
      id: officer.id,
      name: officer.name,
      rarity: officer.rarity,
      group: officer.groupName,
      officerClass: officerClassLabel(officer.officerClass),
      faction: officer.faction ? (officer.faction as Record<string, unknown>).name ?? null : null,
      captainManeuver: officer.captainManeuver,
      officerAbility: officer.officerAbility,
      belowDeckAbility: officer.belowDeckAbility,
    },
    conflict: conflict
      ? {
          locations: conflict.locations.map((loc) => ({
            type: loc.type,
            entityName: loc.entityName,
            slot: loc.slot,
          })),
        }
      : null,
    alternatives,
    affectedLoadouts,
    reservation: reservation
      ? { reservedFor: reservation.reservedFor, locked: reservation.locked }
      : null,
  };
}

export async function whatIfRemoveOfficer(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  let officerName: string | null = null;
  if (ctx.referenceStore) {
    const officer = await ctx.referenceStore.getOfficer(officerId);
    officerName = officer?.name ?? null;
  }

  const loadouts = await ctx.crewStore.listLoadouts();
  const loadoutIds = loadouts.map(l => l.id);
  const fullMap = await ctx.crewStore.getLoadoutsByIds(loadoutIds);
  const affectedLoadouts: Array<Record<string, unknown>> = [];
  for (const l of loadouts) {
    const full = fullMap.get(l.id);
    if (full?.bridgeCore?.members.some((m) => m.officerId === officerId)) {
      affectedLoadouts.push({
        loadoutId: l.id,
        loadoutName: l.name,
        shipId: l.shipId,
      });
    }
  }

  const planItems = await ctx.crewStore.listPlanItems();
  const affectedAwayTeams = planItems
    .filter((p) => p.awayOfficers?.includes(officerId))
    .map((p) => ({
      planItemId: p.id,
      planItemLabel: p.label,
    }));

  return {
    officerId,
    officerName,
    affectedLoadouts,
    affectedAwayTeams,
    totalAffectedLoadouts: affectedLoadouts.length,
    totalAffectedAwayTeams: affectedAwayTeams.length,
    totalAffected: affectedLoadouts.length + affectedAwayTeams.length,
  };
}

// ─── Target/Goal Tracking Implementations ───────────────────

export async function listTargets(
  targetType: string | undefined,
  status: string | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.targetStore) {
    return { error: "Target system not available." };
  }

  const filters: Record<string, unknown> = {};
  if (targetType) filters.targetType = targetType;
  if (status) filters.status = status;
  else filters.status = "active";

  const targets = await ctx.targetStore.list(
    Object.keys(filters).length > 0 ? filters as never : undefined,
  );

  return {
    targets: targets.map((t) => ({
      id: t.id,
      targetType: t.targetType,
      refId: t.refId,
      loadoutId: t.loadoutId,
      targetTier: t.targetTier,
      targetRank: t.targetRank,
      targetLevel: t.targetLevel,
      reason: t.reason,
      priority: t.priority,
      status: t.status,
      autoSuggested: t.autoSuggested,
      achievedAt: t.achievedAt,
    })),
    totalTargets: targets.length,
  };
}

export async function suggestTargets(ctx: ToolContext): Promise<object> {
  const result: Record<string, unknown> = {};

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
    result.ownedShips = overlays
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

  // ── "Ready to Upgrade" notifications ─────────────────────
  // Check owned ships against inventory to find those with enough resources
  // for the next tier, surfacing actionable upgrade opportunities.
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
    } catch {
      // Non-fatal — degrade gracefully if inventory check fails
    }
  }

  return result;
}

export async function detectConflicts(ctx: ToolContext): Promise<object> {
  if (!ctx.targetStore) {
    return { error: "Target system not available." };
  }
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const conflicts = await detectTargetConflicts(ctx.targetStore, ctx.crewStore);

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const c of conflicts) {
    byType[c.conflictType] = (byType[c.conflictType] ?? 0) + 1;
    bySeverity[c.severity] = (bySeverity[c.severity] ?? 0) + 1;
  }

  return {
    conflicts: conflicts.map((c) => ({
      conflictType: c.conflictType,
      severity: c.severity,
      resource: c.resource,
      description: c.description,
      suggestion: c.suggestion,
      targetA: c.targetA,
      targetB: c.targetB,
    })),
    summary: {
      totalConflicts: conflicts.length,
      byType,
      bySeverity,
    },
  };
}
