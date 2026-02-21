import { log } from "../../logger.js";

const WEB_LOOKUP_ALLOWLIST = new Set(["stfc.space", "memory-alpha.fandom.com", "stfc.fandom.com"]);
const WEB_LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000;
const WEB_LOOKUP_RATE_LIMIT_MAX = 5;
const WEB_LOOKUP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const WEB_LOOKUP_FETCH_TIMEOUT_MS = 10_000;
const WEB_LOOKUP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Hardened fetch options: block redirects, enforce timeout. */
function safeFetchInit(): RequestInit {
  return { redirect: "error", signal: AbortSignal.timeout(WEB_LOOKUP_FETCH_TIMEOUT_MS) };
}

/** Read response body with a size cap to prevent memory abuse. */
async function safeReadText(response: Response): Promise<string> {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && Number(contentLength) > WEB_LOOKUP_MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large (${contentLength} bytes)`);
  }
  return response.text();
}

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
    const response = await fetch(`https://${domain}/robots.txt`, safeFetchInit());
    if (!response.ok) {
      return { allowed: false, source: "network", reason: `robots_fetch_failed_${response.status}` };
    }
    const content = (await safeReadText(response)).toLowerCase();
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

  const response = await fetch(url.toString(), safeFetchInit());
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
  const response = await fetch(`https://${domain}/search?q=${encodeURIComponent(query)}`, safeFetchInit());
  if (!response.ok) {
    return { error: `Lookup failed (${response.status}) for ${domain}` };
  }

  const searchHtml = await safeReadText(response);
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

  const detailResponse = await fetch(`https://${domain}${detailPath}`, safeFetchInit());
  if (!detailResponse.ok) {
    return { error: `Lookup failed (${detailResponse.status}) for ${domain}${detailPath}` };
  }
  const detailHtml = await safeReadText(detailResponse);

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