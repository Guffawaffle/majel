/**
 * wiki-ingest.test.ts — Tests for wiki parsing + sync endpoint
 *
 * Tests the pure parsing functions with realistic fixture data,
 * and the POST /api/catalog/sync endpoint with mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp, type AppState } from "../src/server/index.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/reference-store.js";
import { bootstrapConfigSync } from "../src/server/config.js";
import {
  cleanWikitext,
  slugify,
  normalizeRarity,
  parseExportXml,
  parseOfficerTable,
  parseShipTable,
} from "../src/server/wiki-ingest.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Helpers ────────────────────────────────────────────────

let tmpDir: string;
let refStore: ReferenceStore;

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    geminiEngine: null,
    memoryService: null,
    settingsStore: null,
    sessionStore: null,
    dockStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    inviteStore: null,
    startupComplete: true,
    config: bootstrapConfigSync(),
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "majel-wiki-test-"));
  refStore = await createReferenceStore(path.join(tmpDir, "reference.db"));
});

afterEach(async () => {
  await refStore.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Fixture Data ───────────────────────────────────────────

const OFFICER_WIKITEXT = `
Some intro text about officers.

{| class="wikitable sortable" style="text-align: center;"
!Name
!Captain Maneuver
!Officer Ability
!Below Deck Ability
!Group
!Rarity
|-
|style="text-align: center;" |[[Kirk]][[File:Kirk.png|frameless|80px|center]]
|Inspirational
|Lead By Example
|Tactical Genius
|Command
|Epic
|-
|style="text-align: center;" |[[Spock]][[File:Spock.png|frameless|80px|center]]
|Logical Analysis
|Science Officer
|Mind Meld
|Science
|Epic
|-
|style="text-align: center;" |[[Uhura]][[File:Uhura.png|frameless|80px|center]]
|Frequencies Open
|Comm Officer
|Linguistics
|Command
|Rare
|-
|style="text-align: center;" |[[Scotty]][[File:Scotty.png|frameless|80px|center]]
|Miracle Worker
|Engineering
|Repair Protocols
|Engineering
|Legendary
|}

Some footer text.
`;

const SHIP_WIKITEXT = `
Some intro text about ships.

{| class="wikitable sortable" style="text-align: center;"
!Ship
!Rarity
!Shipyard Level
!Average Start Strength
!Weapon Type
!Type
!Best Opponent
|-
|[[Realta]]
|Common ☆
|
|1,934
|Energy
|Explorer
|Interceptor
|-
|[[Orion Corvette]]
|Common ☆
|5
|2,291
|Energy
|Battleship
|Explorer
|-
|[[Phindra]]
|Uncommon ☆☆
|10
|5,000
|Kinetic
|Interceptor
|Battleship
|-
|[[USS Enterprise]]
|Rare ☆☆☆
|25
|50,000
|Energy
|Explorer
|Interceptor
|-
|[[ECS Fortunate]]
|Common ☆
|7
|3,638
|
|Survey
|
|}

Some footer text.
`;

function wrapInExportXml(pageName: string, wikitext: string, pageId = "12345", revId = "67890"): string {
  const escaped = wikitext
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<mediawiki>
<page>
  <title>${pageName}</title>
  <id>${pageId}</id>
  <revision>
    <id>${revId}</id>
    <timestamp>2025-01-15T12:00:00Z</timestamp>
    <text xml:space="preserve">${escaped}</text>
  </revision>
</page>
</mediawiki>`;
}

// ═══════════════════════════════════════════════════════════
// Pure Function Tests
// ═══════════════════════════════════════════════════════════

describe("cleanWikitext", () => {
  it("strips [[File:...]] image markup", () => {
    expect(cleanWikitext("Hello [[File:image.png|frameless|80px]] world")).toBe("Hello world");
  });

  it("simplifies wiki links", () => {
    expect(cleanWikitext("[[Page|Display Text]]")).toBe("Display Text");
    expect(cleanWikitext("[[Simple Link]]")).toBe("Simple Link");
  });

  it("removes bold/italic markup", () => {
    expect(cleanWikitext("'''bold''' and ''italic''")).toBe("bold and italic");
  });

  it("removes HTML tags", () => {
    expect(cleanWikitext("before<br/>after")).toBe("before after");
    expect(cleanWikitext("<span style='color:red'>text</span>")).toBe("text");
  });

  it("collapses whitespace", () => {
    expect(cleanWikitext("  lots   of   spaces  ")).toBe("lots of spaces");
  });

  it("handles empty/null input", () => {
    expect(cleanWikitext("")).toBe("");
  });
});

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Kirk")).toBe("kirk");
    expect(slugify("USS Enterprise")).toBe("uss-enterprise");
  });

  it("removes special characters", () => {
    expect(slugify("B'Rel")).toBe("b-rel");
    expect(slugify("D3 Class")).toBe("d3-class");
  });

  it("strips leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });
});

describe("normalizeRarity", () => {
  it("maps standard rarity names", () => {
    expect(normalizeRarity("Common")).toBe("common");
    expect(normalizeRarity("Epic")).toBe("epic");
    expect(normalizeRarity("Legendary")).toBe("legendary");
  });

  it("strips star characters", () => {
    expect(normalizeRarity("Common ☆")).toBe("common");
    expect(normalizeRarity("Rare ☆☆☆")).toBe("rare");
    expect(normalizeRarity("Epic ☆☆☆☆")).toBe("epic");
  });

  it("returns null for unknown values", () => {
    expect(normalizeRarity("")).toBeNull();
    expect(normalizeRarity("bogus")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// XML Parsing
// ═══════════════════════════════════════════════════════════

describe("parseExportXml", () => {
  it("extracts wikitext and provenance from export XML", () => {
    const xml = wrapInExportXml("Officers", "some wiki content", "111", "222");
    const result = parseExportXml(xml, "Officers");
    expect(result.wikitext).toContain("some wiki content");
    expect(result.provenance.pageId).toBe("111");
    expect(result.provenance.revisionId).toBe("222");
    expect(result.provenance.source).toBe("stfc-fandom-wiki");
  });

  it("throws when target page not found", () => {
    const xml = wrapInExportXml("OtherPage", "content");
    expect(() => parseExportXml(xml, "Officers")).toThrow("No \"Officers\" page found");
  });
});

// ═══════════════════════════════════════════════════════════
// Officer Table Parsing
// ═══════════════════════════════════════════════════════════

describe("parseOfficerTable", () => {
  it("parses officers from wikitable", () => {
    const officers = parseOfficerTable(OFFICER_WIKITEXT);
    expect(officers.length).toBe(4);

    const kirk = officers.find(o => o.name === "Kirk");
    expect(kirk).toBeDefined();
    expect(kirk!.rarity).toBe("epic");
    expect(kirk!.group).toBe("Command");
    expect(kirk!.captainManeuver).toBe("Inspirational");
    expect(kirk!.officerAbility).toBe("Lead By Example");
  });

  it("parses all rarities correctly", () => {
    const officers = parseOfficerTable(OFFICER_WIKITEXT);
    const uhura = officers.find(o => o.name === "Uhura");
    expect(uhura?.rarity).toBe("rare");
    const scotty = officers.find(o => o.name === "Scotty");
    expect(scotty?.rarity).toBe("legendary");
  });

  it("deduplicates by name", () => {
    const dupeWikitext = OFFICER_WIKITEXT.replace("Some footer text.", "") +
      `|-
|style="text-align: center;" |[[Kirk]][[File:Kirk2.png|frameless|80px|center]]
|Inspirational V2
|Lead By Example V2
|Tactical Genius V2
|Command
|Epic
|}

Some footer text.`;
    const officers = parseOfficerTable(dupeWikitext);
    const kirks = officers.filter(o => o.name === "Kirk");
    expect(kirks.length).toBe(1);
  });

  it("throws on missing wikitable", () => {
    expect(() => parseOfficerTable("no table here")).toThrow("Could not locate officer wikitable");
  });
});

// ═══════════════════════════════════════════════════════════
// Ship Table Parsing
// ═══════════════════════════════════════════════════════════

describe("parseShipTable", () => {
  it("parses ships from wikitable", () => {
    const ships = parseShipTable(SHIP_WIKITEXT);
    expect(ships.length).toBe(5);

    const enterprise = ships.find(s => s.name === "USS Enterprise");
    expect(enterprise).toBeDefined();
    expect(enterprise!.rarity).toBe("rare");
    expect(enterprise!.shipClass).toBe("Explorer");
    expect(enterprise!.grade).toBe(3);
  });

  it("parses ship classes correctly", () => {
    const ships = parseShipTable(SHIP_WIKITEXT);
    const realta = ships.find(s => s.name === "Realta");
    expect(realta?.shipClass).toBe("Explorer");
    const corvette = ships.find(s => s.name === "Orion Corvette");
    expect(corvette?.shipClass).toBe("Battleship");
    const phindra = ships.find(s => s.name === "Phindra");
    expect(phindra?.shipClass).toBe("Interceptor");
    const fortunate = ships.find(s => s.name === "ECS Fortunate");
    expect(fortunate?.shipClass).toBe("Survey");
  });

  it("derives grade from star count", () => {
    const ships = parseShipTable(SHIP_WIKITEXT);
    expect(ships.find(s => s.name === "Realta")?.grade).toBe(1);
    expect(ships.find(s => s.name === "Phindra")?.grade).toBe(2);
    expect(ships.find(s => s.name === "USS Enterprise")?.grade).toBe(3);
  });

  it("throws on missing wikitable", () => {
    expect(() => parseShipTable("no table here")).toThrow("Could not locate ship wikitable");
  });
});

// ═══════════════════════════════════════════════════════════
// POST /api/catalog/sync endpoint
// ═══════════════════════════════════════════════════════════

describe("POST /api/catalog/sync", () => {
  it("requires consent flag", async () => {
    const app = createApp(makeState({ referenceStore: refStore }));
    const res = await request(app)
      .post("/api/catalog/sync")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).toContain("consent");
  });

  it("returns 503 when reference store unavailable", async () => {
    const app = createApp(makeState({ referenceStore: null }));
    const res = await request(app)
      .post("/api/catalog/sync")
      .send({ consent: true });
    expect(res.status).toBe(503);
  });

  it("syncs officers and ships from mocked wiki export", async () => {
    // Mock global fetch to return our fixture XML
    const officersXml = wrapInExportXml("Officers", OFFICER_WIKITEXT, "100", "200");
    const shipsXml = wrapInExportXml("Ships", SHIP_WIKITEXT, "300", "400");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("pages=Officers")) {
        return new Response(officersXml, { status: 200 });
      }
      if (urlStr.includes("pages=Ships")) {
        return new Response(shipsXml, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const app = createApp(makeState({ referenceStore: refStore }));
      const res = await request(app)
        .post("/api/catalog/sync")
        .send({ consent: true });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const d = res.body.data;
      // Officers
      expect(d.officers.parsed).toBe(4);
      expect(d.officers.total).toBe(4);
      expect(d.officers.created).toBe(4);
      expect(d.officers.updated).toBe(0);

      // Ships
      expect(d.ships.parsed).toBe(5);
      expect(d.ships.total).toBe(5);
      expect(d.ships.created).toBe(5);
      expect(d.ships.updated).toBe(0);

      // Provenance
      expect(d.provenance.officers.pageId).toBe("100");
      expect(d.provenance.ships.pageId).toBe("300");

      // Verify data is in the store
      const officers = await refStore.listOfficers();
      expect(officers.length).toBe(4);
      const kirk = officers.find(o => o.name === "Kirk");
      expect(kirk?.id).toBe("wiki:officer:kirk");
      expect(kirk?.captainManeuver).toBe("Inspirational");
      expect(kirk?.source).toBe("stfc-fandom-wiki");

      const ships = await refStore.listShips();
      expect(ships.length).toBe(5);
      const enterprise = ships.find(s => s.name === "USS Enterprise");
      expect(enterprise?.id).toBe("wiki:ship:uss-enterprise");
      expect(enterprise?.shipClass).toBe("Explorer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("supports officers-only sync", async () => {
    const officersXml = wrapInExportXml("Officers", OFFICER_WIKITEXT, "100", "200");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("pages=Officers")) {
        return new Response(officersXml, { status: 200 });
      }
      return new Response("Should not be called", { status: 500 });
    }) as typeof fetch;

    try {
      const app = createApp(makeState({ referenceStore: refStore }));
      const res = await request(app)
        .post("/api/catalog/sync")
        .send({ consent: true, ships: false });

      expect(res.status).toBe(200);
      expect(res.body.data.officers.parsed).toBe(4);
      expect(res.body.data.ships.total).toBe(0);

      // Ships should not be fetched
      expect((await refStore.listShips()).length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("re-running sync updates existing records", async () => {
    const officersXml = wrapInExportXml("Officers", OFFICER_WIKITEXT, "100", "200");
    const shipsXml = wrapInExportXml("Ships", SHIP_WIKITEXT, "300", "400");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("pages=Officers")) return new Response(officersXml, { status: 200 });
      if (urlStr.includes("pages=Ships")) return new Response(shipsXml, { status: 200 });
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const app = createApp(makeState({ referenceStore: refStore }));

      // First sync — creates
      const res1 = await request(app).post("/api/catalog/sync").send({ consent: true });
      expect(res1.body.data.officers.created).toBe(4);
      expect(res1.body.data.officers.updated).toBe(0);

      // Second sync — updates
      const res2 = await request(app).post("/api/catalog/sync").send({ consent: true });
      expect(res2.body.data.officers.created).toBe(0);
      expect(res2.body.data.officers.updated).toBe(4);
      expect(res2.body.data.ships.created).toBe(0);
      expect(res2.body.data.ships.updated).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 502 when wiki fetch fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response("Service Unavailable", { status: 503 });
    }) as typeof fetch;

    try {
      const app = createApp(makeState({ referenceStore: refStore }));
      const res = await request(app)
        .post("/api/catalog/sync")
        .send({ consent: true });

      expect(res.status).toBe(502);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.message).toContain("Wiki sync failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
