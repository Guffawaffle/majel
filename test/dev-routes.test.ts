/**
 * dev-routes.test.ts — Tests for dev-only endpoints (ADR-050)
 */

import { describe, it, expect } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import { makeReadyState, makeConfig } from "./helpers/make-state.js";
import { createDevRoutes } from "../src/server/routes/dev.js";
import type { AppState } from "../src/server/app-context.js";
import express from "express";
import { envelopeMiddleware, errorHandler } from "../src/server/envelope.js";

/**
 * Minimal Express app with dev routes for isolated testing.
 * Bypasses full createApp to avoid requiring all middleware.
 */
function makeDevApp(appState: AppState) {
  const app = express();
  app.use(envelopeMiddleware);
  app.use(express.json());
  app.use(createDevRoutes(appState));
  app.use(errorHandler);
  return app;
}

// ─── Defense-in-depth: capability check ─────────────────────────

describe("dev routes — capability guard", () => {
  it("returns 403 when devEndpoints is false", async () => {
    // cloud_prod profile has devEndpoints: false
    const config = makeConfig();
    // Force devEndpoints off by overriding the contract
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, devEndpoints: false },
    };
    const state = makeReadyState({ config: { ...config, contract } });
    const app = makeDevApp(state);

    const res = await testRequest(app).get("/api/dev/state");
    expect(res.status).toBe(403);
  });
});

// ─── /api/dev/state ─────────────────────────────────────────────

describe("GET /api/dev/state", () => {
  it("returns profile and capabilities", async () => {
    const config = makeConfig();
    // Ensure devEndpoints is true
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, devEndpoints: true },
    };
    const state = makeReadyState({ config: { ...config, contract } });
    const app = makeDevApp(state);

    const res = await testRequest(app).get("/api/dev/state");
    expect(res.status).toBe(200);
    expect(res.body.data.profile).toBe(config.profile);
    expect(res.body.data.capabilities).toBeDefined();
    expect(res.body.data.capabilities.devEndpoints).toBe(true);
    expect(res.body.data.startupComplete).toBe(true);
    expect(res.body.data.stores).toBeDefined();
  });
});

// ─── /api/dev/seed ──────────────────────────────────────────────

describe("POST /api/dev/seed", () => {
  it("returns 403 when devSeed is false", async () => {
    const config = makeConfig();
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, devEndpoints: true, devSeed: false },
    };
    const state = makeReadyState({ config: { ...config, contract } });
    const app = makeDevApp(state);

    const res = await testRequest(app).post("/api/dev/seed").set("X-Requested-With", "majel-client");
    expect(res.status).toBe(403);
  });

  it("returns 503 when reference store not available", async () => {
    const config = makeConfig();
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, devEndpoints: true, devSeed: true },
    };
    const state = makeReadyState({ config: { ...config, contract }, referenceStore: null });
    const app = makeDevApp(state);

    const res = await testRequest(app).post("/api/dev/seed").set("X-Requested-With", "majel-client");
    expect(res.status).toBe(503);
  });
});

// ─── /api/dev/reset ─────────────────────────────────────────────

describe("POST /api/dev/reset", () => {
  it("returns 403 when devSeed is false", async () => {
    const config = makeConfig();
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, devEndpoints: true, devSeed: false },
    };
    const state = makeReadyState({ config: { ...config, contract } });
    const app = makeDevApp(state);

    const res = await testRequest(app).post("/api/dev/reset").set("X-Requested-With", "majel-client");
    expect(res.status).toBe(403);
  });

  it("returns 503 when pool not available", async () => {
    const config = makeConfig();
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, devEndpoints: true, devSeed: true },
    };
    const state = makeReadyState({ config: { ...config, contract }, pool: null });
    const app = makeDevApp(state);

    const res = await testRequest(app).post("/api/dev/reset").set("X-Requested-With", "majel-client");
    expect(res.status).toBe(503);
  });

  it("truncates user-scoped tables and returns result", async () => {
    const truncated: string[] = [];
    const mockPool = {
      query: async (sql: string) => {
        const match = sql.match(/TRUNCATE TABLE "(\w+)"/);
        if (match) truncated.push(match[1]);
        return { rows: [], rowCount: 0 };
      },
    };
    const config = makeConfig();
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, devEndpoints: true, devSeed: true },
    };
    const state = makeReadyState({ config: { ...config, contract }, pool: mockPool });
    const app = makeDevApp(state);

    const res = await testRequest(app).post("/api/dev/reset").set("X-Requested-With", "majel-client");
    expect(res.status).toBe(200);
    expect(res.body.data.reset).toBe(true);
    expect(res.body.data.truncated).toEqual(truncated);
    expect(truncated).toContain("ship_overlay");
    expect(truncated).toContain("proposals");
    expect(truncated.length).toBe(10);
  });

  it("skips tables that do not exist (42P01)", async () => {
    const mockPool = {
      query: async (sql: string) => {
        const match = sql.match(/TRUNCATE TABLE "(\w+)"/);
        if (match && match[1] === "research_nodes") {
          const err = new Error("relation does not exist") as Error & { code: string };
          err.code = "42P01";
          throw err;
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const config = makeConfig();
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, devEndpoints: true, devSeed: true },
    };
    const state = makeReadyState({ config: { ...config, contract }, pool: mockPool });
    const app = makeDevApp(state);

    const res = await testRequest(app).post("/api/dev/reset").set("X-Requested-With", "majel-client");
    expect(res.status).toBe(200);
    expect(res.body.data.reset).toBe(true);
    // research_nodes should be skipped, so only 9 truncated
    expect(res.body.data.truncated).not.toContain("research_nodes");
    expect(res.body.data.truncated.length).toBe(9);
  });
});
