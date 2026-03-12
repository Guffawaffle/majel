/**
 * fleet-tools/web-lookup.test.ts — Tests for web_lookup tool
 *
 * Covers: web_lookup (robots.txt, fandom, stfc.space, rate limiting, caching)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeFleetTool,
} from "./helpers.js";
import { __resetWebLookupStateForTests } from "../../src/server/services/fleet-tools/read-tools.js";

describe("web_lookup", () => {
  beforeEach(() => {
    __resetWebLookupStateForTests();
  });

  it("rejects non-allowlisted domains", async () => {
    const result = await executeFleetTool("web_lookup", {
      domain: "example.com",
      query: "Spock",
    }, {});
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not allowlisted");
  });

  it("returns robots policy error when domain disallows all", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow: /\n") });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeFleetTool("web_lookup", {
      domain: "stfc.space",
      query: "Enterprise",
    }, {});

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("robots.txt policy blocks");
    vi.unstubAllGlobals();
  });

  it("returns structured fandom result and serves subsequent requests from cache", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          query: {
            pages: {
              "1": {
                pageid: 1,
                title: "Spock",
                extract: "Spock is a Starfleet officer.",
              },
            },
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const first = await executeFleetTool("web_lookup", {
      domain: "stfc.fandom.com",
      query: "Spock",
      entity_type: "officer",
    }, {}) as Record<string, unknown>;

    expect(first.error).toBeUndefined();
    expect(first.tool).toBe("web_lookup");
    expect((first.sourcePolicy as Record<string, unknown>).approvedStream).toBe(false);
    expect((first.cache as Record<string, unknown>).hit).toBe(false);
    expect(first).toHaveProperty("observability");
    expect((first.result as Record<string, unknown>).title).toBe("Spock");

    const second = await executeFleetTool("web_lookup", {
      domain: "stfc.fandom.com",
      query: "Spock",
      entity_type: "officer",
    }, {}) as Record<string, unknown>;

    expect(second.error).toBeUndefined();
    expect((second.cache as Record<string, unknown>).hit).toBe(true);
    expect(second).toHaveProperty("observability");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("extracts structured stfc.space ship facts from detail page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") })
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`
          <html><body>
            <a href="/ships/uss-enterprise">USS Enterprise</a>
          </body></html>
        `),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`
          <html>
            <head>
              <title>USS Enterprise</title>
              <meta name="description" content="Legendary Federation explorer." />
            </head>
            <body>
              <h1>USS Enterprise</h1>
              <table>
                <tr><th>Hull Type</th><td>Explorer</td></tr>
                <tr><th>Rarity</th><td>Epic</td></tr>
                <tr><th>Faction</th><td>Federation</td></tr>
                <tr><th>Grade</th><td>3</td></tr>
              </table>
            </body>
          </html>
        `),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeFleetTool("web_lookup", {
      domain: "stfc.space",
      query: "Enterprise",
      entity_type: "ship",
    }, {}) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect((result.result as Record<string, unknown>).type).toBe("ship");
    expect((result.result as Record<string, unknown>).hullType).toBe("Explorer");
    expect((result.result as Record<string, unknown>).rarity).toBe("Epic");
    expect((result.result as Record<string, unknown>).faction).toBe("Federation");
    expect((result.result as Record<string, unknown>).grade).toBe("3");
    expect(result).toHaveProperty("observability");
    vi.unstubAllGlobals();
  });

  it("supports allowlisted generic domains like spocks.club", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") })
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`
          <html>
            <head>
              <title>Voyager Blueprints Guide</title>
              <meta name="description" content="Daily loops to improve Voyager blueprint intake." />
            </head>
            <body>
              <h1>Voyager Blueprint Routes</h1>
              <p>Use Away Teams and Hirogen loops to steadily gain blueprints.</p>
            </body>
          </html>
        `),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeFleetTool("web_lookup", {
      domain: "spocks.club",
      query: "Voyager blueprints",
      entity_type: "ship",
    }, {}) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(result.tool).toBe("web_lookup");
    expect((result.sourcePolicy as Record<string, unknown>).approvedStream).toBe(true);
    expect((result.sourcePolicy as Record<string, unknown>).sourceTier).toBe("approved_stream");
    expect((result.result as Record<string, unknown>).title).toContain("Voyager");
    expect((result.result as Record<string, unknown>).type).toBe("ship");
    expect(result).toHaveProperty("observability");
    vi.unstubAllGlobals();
  });

  it("enforces rate limit after max requests", async () => {
    // Mock fetch: allow robots, then succeed for fandom lookups
    const makeFetchMock = () => vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") })
      .mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          query: { pages: { "1": { pageid: 1, title: "Kirk", extract: "Captain Kirk." } } },
        }),
      });

    vi.stubGlobal("fetch", makeFetchMock());

    // First 5 requests should succeed (rate limit is 5 per 60s window)
    for (let i = 0; i < 5; i += 1) {
      const result = await executeFleetTool("web_lookup", {
        domain: "stfc.fandom.com",
        query: `Kirk-${i}`, // unique queries to bypass cache
        entity_type: "officer",
      }, {}) as Record<string, unknown>;
      expect(result.error).toBeUndefined();
    }

    // 6th request should be rate limited
    const limited = await executeFleetTool("web_lookup", {
      domain: "stfc.fandom.com",
      query: "Kirk-overflow",
      entity_type: "officer",
    }, {}) as Record<string, unknown>;

    expect(limited).toHaveProperty("error");
    expect(limited.error).toContain("Rate limit exceeded");
    expect(limited).toHaveProperty("retryAfterMs");
    expect(typeof limited.retryAfterMs).toBe("number");
    expect(limited).toHaveProperty("observability");

    vi.unstubAllGlobals();
  });

  it("rate limits are per-domain", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") });
    vi.stubGlobal("fetch", fetchMock);

    // Exhaust rate limit for stfc.fandom.com (robots check + 4 more = 5 events)
    vi.unstubAllGlobals();
    __resetWebLookupStateForTests();

    const fetchMock2 = vi.fn()
      .mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n"),
        json: vi.fn().mockResolvedValue({
          query: { pages: { "1": { pageid: 1, title: "Test", extract: "Test officer." } } },
        }),
      });
    vi.stubGlobal("fetch", fetchMock2);

    // stfc.space: should succeed independently (fresh rate limit window)
    const result = await executeFleetTool("web_lookup", {
      domain: "stfc.space",
      query: "Enterprise",
      entity_type: "ship",
    }, {}) as Record<string, unknown>;

    // Should reach the lookup (not rate-limited), regardless of stfc.fandom.com usage
    expect(result.error).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("observability metrics reflect rate-limited requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") })
      .mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          query: { pages: { "1": { pageid: 1, title: "Spock", extract: "Vulcan." } } },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    // Fill rate limit
    for (let i = 0; i < 5; i += 1) {
      await executeFleetTool("web_lookup", {
        domain: "stfc.fandom.com",
        query: `Spock-obs-${i}`,
        entity_type: "officer",
      }, {});
    }

    // Trigger rate-limited request
    const limited = await executeFleetTool("web_lookup", {
      domain: "stfc.fandom.com",
      query: "Spock-obs-overflow",
      entity_type: "officer",
    }, {}) as Record<string, unknown>;

    const obs = limited.observability as Record<string, number>;
    expect(obs.rateLimited).toBeGreaterThanOrEqual(1);

    vi.unstubAllGlobals();
  });
});

// ─── Individual Tools ───────────────────────────────────────

