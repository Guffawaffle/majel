/**
 * scan.test.ts — ADR-008 Phase B: Structured Image Extraction Tests
 *
 * Tests for POST /api/fleet/scan route validation and the scan service
 * (extraction prompt parsing, cross-reference matching).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import type { AppState } from "../src/server/app-context.js";
import { makeReadyState, makeConfig } from "./helpers/make-state.js";
import {
  parseExtractionResponse,
  crossReference,
  type ScanExtraction,
} from "../src/server/services/scan.js";

// ─── Helpers ──────────────────────────────────────────────────

const ADMIN_TOKEN = "test-scan-token";
const bearer = `Bearer ${ADMIN_TOKEN}`;

// Tiny 1x1 transparent PNG in base64
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/pooBPQAAAABJRU5ErkJggg==";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return makeReadyState({
    config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true, geminiApiKey: "test-key" }),
    referenceStore: makeMockReferenceStore(),
    ...overrides,
  });
}

function makeMockReferenceStore() {
  return {
    findOfficerByName: vi.fn().mockResolvedValue(null),
    searchOfficers: vi.fn().mockResolvedValue([]),
    findShipByName: vi.fn().mockResolvedValue(null),
    searchShips: vi.fn().mockResolvedValue([]),
    // Stubs for unused methods
    createOfficer: vi.fn(), getOfficer: vi.fn(), listOfficers: vi.fn(),
    upsertOfficer: vi.fn(), deleteOfficer: vi.fn(),
    createShip: vi.fn(), getShip: vi.fn(), listShips: vi.fn(),
    upsertShip: vi.fn(), deleteShip: vi.fn(),
    bulkUpsertOfficers: vi.fn(), bulkUpsertShips: vi.fn(),
    bulkUpsertResearch: vi.fn(), bulkUpsertBuildings: vi.fn(),
    bulkUpsertHostiles: vi.fn(), bulkUpsertConsumables: vi.fn(),
    bulkUpsertSystems: vi.fn(), purgeLegacyEntries: vi.fn(),
    getResearch: vi.fn(), searchResearch: vi.fn(),
    getBuilding: vi.fn(), searchBuildings: vi.fn(),
    getHostile: vi.fn(), searchHostiles: vi.fn(),
    getConsumable: vi.fn(), searchConsumables: vi.fn(),
    getSystem: vi.fn(), searchSystems: vi.fn(),
    listSystemsByResource: vi.fn(), searchSystemsByMining: vi.fn(),
    initSchema: vi.fn(), close: vi.fn(),
  } as any;
}

// ─── Route Validation Tests ───────────────────────────────────

describe("POST /api/fleet/scan — validation (ADR-008 Phase B)", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeState());
  });

  it("rejects missing scanType", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .set("Authorization", bearer)
      .send({ image: { data: TINY_PNG, mimeType: "image/png" } });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("scanType");
  });

  it("rejects invalid scanType", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .set("Authorization", bearer)
      .send({
        image: { data: TINY_PNG, mimeType: "image/png" },
        scanType: "weapons",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("weapons");
  });

  it("rejects missing image", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .set("Authorization", bearer)
      .send({ scanType: "officer" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("image");
  });

  it("rejects image without data field", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .set("Authorization", bearer)
      .send({
        scanType: "officer",
        image: { mimeType: "image/png" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("data");
  });

  it("rejects image without mimeType field", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .set("Authorization", bearer)
      .send({
        scanType: "officer",
        image: { data: TINY_PNG },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("data");
  });

  it("rejects unsupported image MIME type", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .set("Authorization", bearer)
      .send({
        scanType: "officer",
        image: { data: TINY_PNG, mimeType: "image/gif" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("image/gif");
  });

  it("rejects non-string image data", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .set("Authorization", bearer)
      .send({
        scanType: "officer",
        image: { data: 12345, mimeType: "image/png" },
      });

    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .send({
        scanType: "officer",
        image: { data: TINY_PNG, mimeType: "image/png" },
      });

    expect(res.status).toBe(401);
  });

  it("returns 503 when Gemini API key is not configured", async () => {
    app = createApp(makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true, geminiApiKey: "" }),
    }));

    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .set("Authorization", bearer)
      .send({
        scanType: "officer",
        image: { data: TINY_PNG, mimeType: "image/png" },
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("GEMINI_NOT_READY");
  });

  it("returns 503 when reference store is not available", async () => {
    app = createApp(makeState({ referenceStore: null }));

    const res = await testRequest(app)
      .post("/api/fleet/scan")
      .set("Authorization", bearer)
      .send({
        scanType: "officer",
        image: { data: TINY_PNG, mimeType: "image/png" },
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("REFERENCE_STORE_NOT_AVAILABLE");
  });

  it("accepts all valid scan types", () => {
    for (const scanType of ["officer", "ship", "event", "auto"]) {
      expect(["officer", "ship", "event", "auto"]).toContain(scanType);
    }
  });
});

// ─── Extraction Response Parsing Tests ────────────────────────

describe("parseExtractionResponse", () => {
  it("parses valid officer extraction JSON", () => {
    const json = JSON.stringify({
      scanType: "officer",
      officers: [{ name: "James T. Kirk", rarity: "epic", level: 45, group: "command" }],
      confidence: 0.92,
      rawText: "Kirk - Level 45",
    });

    const result = parseExtractionResponse(json, "officer");
    expect(result.scanType).toBe("officer");
    expect(result.confidence).toBe(0.92);
    expect(result.officers).toHaveLength(1);
    expect(result.officers![0].name).toBe("James T. Kirk");
    expect(result.officers![0].level).toBe(45);
  });

  it("parses valid ship extraction JSON", () => {
    const json = JSON.stringify({
      scanType: "ship",
      ships: [{ name: "USS Enterprise", shipClass: "explorer", tier: 8 }],
      confidence: 0.85,
    });

    const result = parseExtractionResponse(json, "ship");
    expect(result.scanType).toBe("ship");
    expect(result.ships).toHaveLength(1);
    expect(result.ships![0].name).toBe("USS Enterprise");
    expect(result.ships![0].tier).toBe(8);
  });

  it("parses valid event extraction JSON", () => {
    const json = JSON.stringify({
      scanType: "event",
      events: [{ name: "Mining Madness", type: "mining", scoring: "points per ore" }],
      confidence: 0.78,
    });

    const result = parseExtractionResponse(json, "event");
    expect(result.events).toHaveLength(1);
    expect(result.events![0].name).toBe("Mining Madness");
  });

  it("strips markdown code fences", () => {
    const json = "```json\n" + JSON.stringify({
      scanType: "officer",
      officers: [{ name: "Spock" }],
      confidence: 0.9,
    }) + "\n```";

    const result = parseExtractionResponse(json, "officer");
    expect(result.officers).toHaveLength(1);
    expect(result.officers![0].name).toBe("Spock");
  });

  it("clamps confidence to [0, 1]", () => {
    const over = parseExtractionResponse(JSON.stringify({ confidence: 1.5 }), "officer");
    expect(over.confidence).toBe(1);

    const under = parseExtractionResponse(JSON.stringify({ confidence: -0.3 }), "officer");
    expect(under.confidence).toBe(0);
  });

  it("handles non-JSON response gracefully", () => {
    const result = parseExtractionResponse("I cannot read this image clearly", "officer");
    expect(result.confidence).toBe(0);
    expect(result.note).toContain("Failed to parse");
    expect(result.rawText).toBe("I cannot read this image clearly");
  });

  it("falls back to requested scanType when response omits it", () => {
    const result = parseExtractionResponse(JSON.stringify({ confidence: 0.5 }), "ship");
    expect(result.scanType).toBe("ship");
  });

  it("ignores non-array officers/ships/events fields", () => {
    const result = parseExtractionResponse(
      JSON.stringify({ officers: "not an array", ships: 42, confidence: 0.5 }),
      "officer",
    );
    expect(result.officers).toBeUndefined();
    expect(result.ships).toBeUndefined();
  });

  it("preserves note field from model response", () => {
    const result = parseExtractionResponse(
      JSON.stringify({ confidence: 0.3, note: "Image was blurry" }),
      "officer",
    );
    expect(result.note).toBe("Image was blurry");
  });
});

// ─── Cross-Reference Tests ────────────────────────────────────

describe("crossReference", () => {
  it("matches extracted officers against reference catalog", async () => {
    const refStore = makeMockReferenceStore();
    refStore.findOfficerByName.mockResolvedValue({ id: "cdn:officer:kirk", name: "James T. Kirk" });

    const extraction: ScanExtraction = {
      scanType: "officer",
      officers: [{ name: "James T. Kirk", level: 45 }],
      confidence: 0.9,
    };

    const matched = await crossReference(extraction, refStore);
    expect(matched).toHaveLength(1);
    expect(matched[0].refId).toBe("cdn:officer:kirk");
    expect(matched[0].entityType).toBe("officer");
  });

  it("falls back to searchOfficers when findByName returns null", async () => {
    const refStore = makeMockReferenceStore();
    refStore.findOfficerByName.mockResolvedValue(null);
    refStore.searchOfficers.mockResolvedValue([{ id: "cdn:officer:kirk", name: "James T. Kirk" }]);

    const extraction: ScanExtraction = {
      scanType: "officer",
      officers: [{ name: "Kirk" }],
      confidence: 0.7,
    };

    const matched = await crossReference(extraction, refStore);
    expect(matched).toHaveLength(1);
    expect(refStore.searchOfficers).toHaveBeenCalledWith("Kirk");
  });

  it("detects level changes when overlay exists", async () => {
    const refStore = makeMockReferenceStore();
    refStore.findOfficerByName.mockResolvedValue({ id: "cdn:officer:kirk", name: "James T. Kirk" });

    const overlayStore = {
      getOfficerOverlay: vi.fn().mockResolvedValue({ level: 30, rank: "3" }),
      getShipOverlay: vi.fn().mockResolvedValue(null),
    } as any;

    const extraction: ScanExtraction = {
      scanType: "officer",
      officers: [{ name: "James T. Kirk", level: 45, rank: 3 }],
      confidence: 0.9,
    };

    const matched = await crossReference(extraction, refStore, overlayStore);
    expect(matched).toHaveLength(1);
    expect(matched[0].changes).toHaveLength(1);
    expect(matched[0].changes[0]).toEqual({ field: "level", from: 30, to: 45 });
  });

  it("matches ships against reference catalog", async () => {
    const refStore = makeMockReferenceStore();
    refStore.findShipByName.mockResolvedValue({ id: "cdn:ship:enterprise", name: "USS Enterprise" });

    const extraction: ScanExtraction = {
      scanType: "ship",
      ships: [{ name: "USS Enterprise", tier: 8 }],
      confidence: 0.85,
    };

    const matched = await crossReference(extraction, refStore);
    expect(matched).toHaveLength(1);
    expect(matched[0].refId).toBe("cdn:ship:enterprise");
    expect(matched[0].entityType).toBe("ship");
  });

  it("detects ship tier changes when overlay exists", async () => {
    const refStore = makeMockReferenceStore();
    refStore.findShipByName.mockResolvedValue({ id: "cdn:ship:enterprise", name: "USS Enterprise" });

    const overlayStore = {
      getOfficerOverlay: vi.fn().mockResolvedValue(null),
      getShipOverlay: vi.fn().mockResolvedValue({ tier: 6, level: 20 }),
    } as any;

    const extraction: ScanExtraction = {
      scanType: "ship",
      ships: [{ name: "USS Enterprise", tier: 8, level: 30 }],
      confidence: 0.85,
    };

    const matched = await crossReference(extraction, refStore, overlayStore);
    expect(matched[0].changes).toEqual([
      { field: "tier", from: 6, to: 8 },
      { field: "level", from: 20, to: 30 },
    ]);
  });

  it("returns empty matches for unrecognized entities", async () => {
    const refStore = makeMockReferenceStore();

    const extraction: ScanExtraction = {
      scanType: "officer",
      officers: [{ name: "Unknown Officer" }],
      confidence: 0.5,
    };

    const matched = await crossReference(extraction, refStore);
    expect(matched).toHaveLength(0);
  });

  it("skips officers with no name", async () => {
    const refStore = makeMockReferenceStore();

    const extraction: ScanExtraction = {
      scanType: "officer",
      officers: [{ name: "" }, { name: "Spock" }],
      confidence: 0.5,
    };

    refStore.findOfficerByName.mockImplementation(async (name: string) =>
      name === "Spock" ? { id: "cdn:officer:spock", name: "Spock" } : null,
    );

    const matched = await crossReference(extraction, refStore);
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("Spock");
  });

  it("handles extraction with no officers or ships", async () => {
    const refStore = makeMockReferenceStore();

    const extraction: ScanExtraction = {
      scanType: "event",
      events: [{ name: "Mining Monday" }],
      confidence: 0.8,
    };

    const matched = await crossReference(extraction, refStore);
    expect(matched).toHaveLength(0);
  });

  it("handles multiple officers in one extraction", async () => {
    const refStore = makeMockReferenceStore();
    refStore.findOfficerByName.mockImplementation(async (name: string) => {
      if (name === "Kirk") return { id: "cdn:officer:kirk", name: "Kirk" };
      if (name === "Spock") return { id: "cdn:officer:spock", name: "Spock" };
      return null;
    });

    const extraction: ScanExtraction = {
      scanType: "officer",
      officers: [
        { name: "Kirk", level: 40 },
        { name: "Spock", level: 38 },
        { name: "Mystery Officer" },
      ],
      confidence: 0.8,
    };

    const matched = await crossReference(extraction, refStore);
    expect(matched).toHaveLength(2);
    expect(matched.map((m) => m.name)).toEqual(["Kirk", "Spock"]);
  });
});
