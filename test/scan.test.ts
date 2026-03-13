/**
 * scan.test.ts — ADR-008 Phase B+C: Structured Image Extraction + Smart Import Tests
 *
 * Tests for POST /api/fleet/scan route validation, the scan service
 * (extraction prompt parsing, cross-reference matching), and Phase C
 * batch + commit endpoints.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import type { AppState } from "../src/server/app-context.js";
import { makeReadyState, makeConfig, makeState } from "./helpers/make-state.js";
import {
  parseExtractionResponse,
  crossReference,
  type ScanExtraction,
} from "../src/server/services/scan.js";
import { createTestPool, truncatePublicTables, type Pool } from "./helpers/pg-test.js";
import { createOverlayStore, type OverlayStore } from "../src/server/stores/overlay-store.js";
import { createReceiptStore, type ReceiptStore } from "../src/server/stores/receipt-store.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";

// ─── Helpers ──────────────────────────────────────────────────

const ADMIN_TOKEN = "test-scan-token";
const bearer = `Bearer ${ADMIN_TOKEN}`;

// Tiny 1x1 transparent PNG in base64
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/pooBPQAAAABJRU5ErkJggg==";

function makeScanState(overrides: Partial<AppState> = {}): AppState {
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

/** State for batch/commit validation tests (no real DB needed). */
function makeBatchState(overrides: Partial<AppState> = {}): AppState {
  return makeReadyState({
    config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true, geminiApiKey: "test-key" }),
    referenceStore: makeMockReferenceStore(),
    ...overrides,
  });
}

// ─── Route Validation Tests ───────────────────────────────────

describe("POST /api/fleet/scan — validation (ADR-008 Phase B)", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeScanState());
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
    app = createApp(makeScanState({
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
    app = createApp(makeScanState({ referenceStore: null }));

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

// ─── Batch Scan Validation Tests (Phase C) ────────────────────

describe("POST /api/fleet/scan/batch — validation (ADR-008 Phase C)", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeBatchState());
  });

  it("rejects missing images array", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/batch")
      .set("Authorization", bearer)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("images");
  });

  it("rejects empty images array", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/batch")
      .set("Authorization", bearer)
      .send({ images: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("images");
  });

  it("rejects batch exceeding 10 images", async () => {
    const images = Array.from({ length: 11 }, () => ({
      image: { data: TINY_PNG, mimeType: "image/png" },
      scanType: "auto",
    }));

    const res = await testRequest(app)
      .post("/api/fleet/scan/batch")
      .set("Authorization", bearer)
      .send({ images });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("10");
  });

  it("rejects invalid scanType in batch entry", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/batch")
      .set("Authorization", bearer)
      .send({
        images: [
          { image: { data: TINY_PNG, mimeType: "image/png" }, scanType: "weapons" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("images[0].scanType");
  });

  it("rejects missing image data in batch entry", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/batch")
      .set("Authorization", bearer)
      .send({
        images: [
          { image: { mimeType: "image/png" }, scanType: "officer" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("images[0]");
  });

  it("rejects unsupported image type in batch entry", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/batch")
      .set("Authorization", bearer)
      .send({
        images: [
          { image: { data: TINY_PNG, mimeType: "image/gif" }, scanType: "officer" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("images[0]");
  });

  it("returns 503 when Gemini API key is not configured", async () => {
    app = createApp(makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true, geminiApiKey: "" }),
      referenceStore: makeMockReferenceStore(),
      startupComplete: true,
    }));

    const res = await testRequest(app)
      .post("/api/fleet/scan/batch")
      .set("Authorization", bearer)
      .send({
        images: [
          { image: { data: TINY_PNG, mimeType: "image/png" }, scanType: "officer" },
        ],
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("GEMINI_NOT_READY");
  });

  it("requires authentication", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/batch")
      .send({ images: [{ image: { data: TINY_PNG, mimeType: "image/png" }, scanType: "officer" }] });

    expect(res.status).toBe(401);
  });
});

// ─── Scan Commit Validation Tests (Phase C) ───────────────────

describe("POST /api/fleet/scan/commit — validation (ADR-008 Phase C)", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeBatchState());
  });

  it("rejects missing entities array", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .set("Authorization", bearer)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("entities");
  });

  it("rejects empty entities array", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .set("Authorization", bearer)
      .send({ entities: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("entities");
  });

  it("rejects invalid entityType", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .set("Authorization", bearer)
      .send({ entities: [{ entityType: "event", refId: "foo" }] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("entityType");
  });

  it("rejects missing refId", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .set("Authorization", bearer)
      .send({ entities: [{ entityType: "officer", refId: "" }] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("refId");
  });

  it("requires authentication", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .send({ entities: [{ entityType: "officer", refId: "test" }] });

    expect(res.status).toBe(401);
  });
});

// ─── Scan Commit Integration Tests (Phase C) ─────────────────

describe("POST /api/fleet/scan/commit — integration (ADR-008 Phase C)", () => {
  let pool: Pool;
  let app: Express;
  let overlayStore: OverlayStore;
  let receiptStore: ReceiptStore;
  let referenceStore: ReferenceStore;

  const REF_DEFAULTS = {
    source: "test",
    sourceUrl: null,
    sourcePageId: null,
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  };

  beforeAll(async () => {
    pool = createTestPool();
    referenceStore = await createReferenceStore(pool);
    overlayStore = await createOverlayStore(pool);
    receiptStore = await createReceiptStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    app = createApp(
      makeState({
        pool,
        referenceStore,
        overlayStore,
        receiptStore,
        startupComplete: true,
      }),
    );

    await referenceStore.upsertOfficer({
      id: "kirk",
      name: "Kirk",
      rarity: "Epic",
      groupName: "Command",
      captainManeuver: null,
      officerAbility: null,
      belowDeckAbility: null,
      ...REF_DEFAULTS,
    });

    await referenceStore.upsertShip({
      id: "enterprise",
      name: "Enterprise",
      shipClass: "Explorer",
      tier: 3,
      grade: null,
      rarity: null,
      faction: null,
      ...REF_DEFAULTS,
    });
  });

  it("commits officer scan results and creates receipt", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .send({
        entities: [
          { entityType: "officer", refId: "kirk", level: 45, rank: 4, power: 9500 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.receipt.id).toBeGreaterThan(0);
    expect(res.body.data.summary.added).toBe(1);
    expect(res.body.data.summary.updated).toBe(0);

    // Verify overlay was created
    const overlay = await overlayStore.getOfficerOverlay("kirk");
    expect(overlay).not.toBeNull();
    expect(overlay!.level).toBe(45);
    expect(overlay!.rank).toBe("4");
    expect(overlay!.power).toBe(9500);
    expect(overlay!.ownershipState).toBe("owned");
  });

  it("commits ship scan results and creates receipt", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .send({
        entities: [
          { entityType: "ship", refId: "enterprise", tier: 8, level: 40, power: 250000 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.summary.added).toBe(1);

    const overlay = await overlayStore.getShipOverlay("enterprise");
    expect(overlay).not.toBeNull();
    expect(overlay!.tier).toBe(8);
    expect(overlay!.level).toBe(40);
    expect(overlay!.power).toBe(250000);
    expect(overlay!.ownershipState).toBe("owned");
  });

  it("updates existing overlay when committing scan results", async () => {
    // Seed existing overlay
    await overlayStore.setOfficerOverlay({
      refId: "kirk",
      ownershipState: "owned",
      level: 30,
      rank: "3",
      power: 5000,
    });

    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .send({
        entities: [
          { entityType: "officer", refId: "kirk", level: 45, rank: 4 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.summary.updated).toBe(1);
    expect(res.body.data.summary.added).toBe(0);

    const overlay = await overlayStore.getOfficerOverlay("kirk");
    expect(overlay!.level).toBe(45);
    expect(overlay!.rank).toBe("4");
    // Power preserved from before (COALESCE)
    expect(overlay!.power).toBe(5000);
  });

  it("commits mixed officer and ship entities in one request", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .send({
        entities: [
          { entityType: "officer", refId: "kirk", level: 45 },
          { entityType: "ship", refId: "enterprise", tier: 8 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.summary.total).toBe(2);
    expect(res.body.data.summary.added).toBe(2);
  });

  it("creates receipt with source_type image_scan", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .send({
        entities: [
          { entityType: "officer", refId: "kirk", level: 45 },
        ],
      });

    expect(res.status).toBe(200);
    const receiptId = res.body.data.receipt.id;

    const receipt = await receiptStore.getReceipt(receiptId);
    expect(receipt).not.toBeNull();
    expect(receipt!.sourceType).toBe("image_scan");
    expect(receipt!.layer).toBe("ownership");
    expect(receipt!.changeset.added).toHaveLength(1);
  });

  it("stores inverse data for undo support", async () => {
    await overlayStore.setOfficerOverlay({
      refId: "kirk",
      ownershipState: "owned",
      level: 30,
    });

    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .send({
        entities: [
          { entityType: "officer", refId: "kirk", level: 45 },
        ],
      });

    const receipt = await receiptStore.getReceipt(res.body.data.receipt.id);
    expect(receipt!.inverse.updated).toHaveLength(1);
    const inverse = receipt!.inverse.updated![0] as Record<string, unknown>;
    expect(inverse.entityType).toBe("officer");
    expect(inverse.refId).toBe("kirk");
    expect((inverse.before as Record<string, unknown>)?.level).toBe(30);
  });

  it("rejects unknown reference IDs", async () => {
    const res = await testRequest(app)
      .post("/api/fleet/scan/commit")
      .send({
        entities: [
          { entityType: "officer", refId: "nonexistent-officer", level: 10 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("nonexistent-officer");
  });

  it("preserves existing target and notes on overlay during scan commit", async () => {
    await overlayStore.setOfficerOverlay({
      refId: "kirk",
      ownershipState: "owned",
      target: true,
      targetNote: "Priority crew member",
      targetPriority: 1,
      level: 30,
    });

    await testRequest(app)
      .post("/api/fleet/scan/commit")
      .send({
        entities: [
          { entityType: "officer", refId: "kirk", level: 45 },
        ],
      });

    const overlay = await overlayStore.getOfficerOverlay("kirk");
    expect(overlay!.target).toBe(true);
    expect(overlay!.targetNote).toBe("Priority crew member");
    expect(overlay!.targetPriority).toBe(1);
  });
});
