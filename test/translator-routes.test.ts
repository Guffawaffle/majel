/**
 * translator-routes.test.ts — Route integration tests for Translator API (#78 Phase 5)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Tests the Express routes for external overlay translation using supertest
 * against the app factory with mocked translator functions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import { createApp } from "../src/server/index.js";
import { makeState } from "./helpers/make-state.js";
import type { ToolContextFactory } from "../src/server/services/fleet-tools/declarations.js";

// ─── Mock translator service ────────────────────────────────

vi.mock("../src/server/services/translator/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/services/translator/index.js")>();
  return {
    ...mod,
    listTranslatorConfigs: vi.fn().mockResolvedValue([
      {
        name: "STFC Command Center Export",
        sourceType: "command-center",
        description: "Translates command center data",
        path: "/data/translators/stfc-command-center-v1.translator.json",
      },
    ]),
    loadTranslatorConfig: vi.fn().mockResolvedValue({
      name: "STFC Command Center Export",
      version: "1.0",
      sourceType: "command-center",
      officers: {
        sourcePath: "officers",
        idField: "id",
        idPrefix: "cdn:officer:",
        fieldMap: { level: "level", rank: "rank" },
      },
    }),
    translate: vi.fn().mockReturnValue({
      success: true,
      data: {
        version: "1.0",
        exportDate: "2026-02-21T00:00:00.000Z",
        source: "command-center",
        officers: [{ refId: "cdn:officer:kirk", level: 50, rank: "Captain" }],
      },
      stats: {
        officers: { translated: 1, skipped: 0, errored: 0 },
        ships: { translated: 0, skipped: 0, errored: 0 },
        docks: { translated: 0, skipped: 0, errored: 0 },
      },
      warnings: [],
    }),
  };
});

// ─── Mock fleet tools ───────────────────────────────────────

vi.mock("../src/server/services/fleet-tools/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/services/fleet-tools/index.js")>();
  return {
    ...mod,
    executeFleetTool: vi.fn().mockResolvedValue({
      tool: "sync_overlay",
      dryRun: true,
      summary: { officers: { input: 1, changed: 1 }, ships: { input: 0, changed: 0 } },
      changesPreview: { officers: [], ships: [] },
      warnings: [],
    }),
  };
});

// Re-import mocked modules so we can adjust per-test
import {
  listTranslatorConfigs,
  loadTranslatorConfig,
  translate,
} from "../src/server/services/translator/index.js";
import { executeFleetTool } from "../src/server/services/fleet-tools/index.js";

const mockedList = vi.mocked(listTranslatorConfigs);
const mockedLoad = vi.mocked(loadTranslatorConfig);
const mockedTranslate = vi.mocked(translate);
const mockedExecute = vi.mocked(executeFleetTool);

// ─── Helpers ────────────────────────────────────────────────

function createMockToolContextFactory(): ToolContextFactory {
  return {
    forUser: vi.fn().mockReturnValue({
      userId: "local",
      referenceStore: null,
      overlayStore: null,
      crewStore: null,
      targetStore: null,
      receiptStore: null,
      researchStore: null,
      inventoryStore: null,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Reset default mock return values
  mockedList.mockResolvedValue([
    {
      name: "STFC Command Center Export",
      sourceType: "command-center",
      description: "Translates command center data",
      path: "/data/translators/stfc-command-center-v1.translator.json",
    },
  ]);
  mockedLoad.mockResolvedValue({
    name: "STFC Command Center Export",
    version: "1.0",
    sourceType: "command-center",
    officers: {
      sourcePath: "officers",
      idField: "id",
      idPrefix: "cdn:officer:",
      fieldMap: { level: "level", rank: "rank" },
    },
  });
  mockedTranslate.mockReturnValue({
    success: true,
    data: {
      version: "1.0",
      exportDate: "2026-02-21T00:00:00.000Z",
      source: "command-center",
      officers: [{ refId: "cdn:officer:kirk", level: 50, rank: "Captain" }],
    },
    stats: {
      officers: { translated: 1, skipped: 0, errored: 0 },
      ships: { translated: 0, skipped: 0, errored: 0 },
      docks: { translated: 0, skipped: 0, errored: 0 },
    },
    warnings: [],
  });
  mockedExecute.mockResolvedValue({
    tool: "sync_overlay",
    dryRun: true,
    summary: { officers: { input: 1, changed: 1 }, ships: { input: 0, changed: 0 } },
    changesPreview: { officers: [], ships: [] },
    warnings: [],
  });
});

// ─── GET /api/translate/configs ─────────────────────────────

describe("GET /api/translate/configs", () => {
  it("returns config list", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/translate/configs");
    expect(res.status).toBe(200);
    expect(res.body.data.configs).toHaveLength(1);
    expect(res.body.data.configs[0].name).toBe("STFC Command Center Export");
    expect(res.body.data.configs[0].sourceType).toBe("command-center");
  });
});

// ─── POST /api/translate/preview ────────────────────────────

describe("POST /api/translate/preview", () => {
  it("returns 400 when configName is missing", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/preview")
      .send({ payload: { officers: [] } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("returns 400 when configName contains path traversal", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/preview")
      .send({ configName: "../etc/passwd", payload: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
    expect(res.body.error.message).toContain("invalid characters");
  });

  it("returns 400 when payload is missing", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/preview")
      .send({ configName: "stfc-command-center-v1" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("returns translation result for valid request", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/preview")
      .send({
        configName: "stfc-command-center-v1",
        payload: { officers: [{ id: "kirk", level: 50 }] },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.data.officers).toHaveLength(1);
    expect(mockedLoad).toHaveBeenCalledTimes(1);
    expect(mockedTranslate).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when loadTranslatorConfig throws", async () => {
    mockedLoad.mockRejectedValueOnce(new Error("Config not found"));
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/preview")
      .send({
        configName: "nonexistent",
        payload: { officers: [] },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Translation failed");
  });
});

// ─── POST /api/translate/apply ──────────────────────────────

describe("POST /api/translate/apply", () => {
  it("returns translation + sync result for valid request with dry_run", async () => {
    const tcf = createMockToolContextFactory();
    const state = makeState({ startupComplete: true, toolContextFactory: tcf });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/apply")
      .send({
        configName: "stfc-command-center-v1",
        payload: { officers: [{ id: "kirk", level: 50 }] },
        dry_run: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.translation.success).toBe(true);
    expect(res.body.data.sync).toBeDefined();
    expect(res.body.data.sync.tool).toBe("sync_overlay");
    expect(mockedExecute).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when toolContextFactory is not available", async () => {
    const state = makeState({ startupComplete: true, toolContextFactory: null });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/apply")
      .send({
        configName: "stfc-command-center-v1",
        payload: { officers: [{ id: "kirk", level: 50 }] },
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("returns sync=null when translation fails", async () => {
    mockedTranslate.mockReturnValueOnce({
      success: false,
      data: null,
      stats: {
        officers: { translated: 0, skipped: 0, errored: 0 },
        ships: { translated: 0, skipped: 0, errored: 0 },
        docks: { translated: 0, skipped: 0, errored: 0 },
      },
      warnings: ["payload must be a non-null object"],
    });

    const tcf = createMockToolContextFactory();
    const state = makeState({ startupComplete: true, toolContextFactory: tcf });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/apply")
      .send({
        configName: "stfc-command-center-v1",
        payload: { officers: [] },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.translation.success).toBe(false);
    expect(res.body.data.sync).toBeNull();
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it("returns 400 when configName is missing", async () => {
    const tcf = createMockToolContextFactory();
    const state = makeState({ startupComplete: true, toolContextFactory: tcf });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/apply")
      .send({ payload: { officers: [] } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("returns 400 when payload is missing", async () => {
    const tcf = createMockToolContextFactory();
    const state = makeState({ startupComplete: true, toolContextFactory: tcf });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/translate/apply")
      .send({ configName: "stfc-command-center-v1" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });
});
