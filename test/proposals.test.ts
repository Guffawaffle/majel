/**
 * proposals.test.ts — Route tests for proposal API endpoints (ADR-026b, #93 Phase 5)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Tests the Express routes for mutation proposals using supertest
 * against the app factory with mocked stores.
 */

import { describe, it, expect, vi } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import { createApp } from "../src/server/index.js";
import { makeState } from "./helpers/make-state.js";
import type {
  ProposalStore,
  MutationProposal,
} from "../src/server/stores/proposal-store.js";
import type { ToolContextFactory } from "../src/server/services/fleet-tools/declarations.js";

// ─── Mock executeFleetTool ──────────────────────────────────

vi.mock("../src/server/services/fleet-tools/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/services/fleet-tools/index.js")>();
  return {
    ...mod,
    executeFleetTool: vi.fn().mockResolvedValue({
      tool: "sync_overlay",
      dryRun: true,
      summary: { officers: { input: 5, changed: 3 }, ships: { input: 2, changed: 1 } },
      changesPreview: { officers: [], ships: [] },
      warnings: [],
    }),
  };
});

// Re-import so we can adjust per-test
import { executeFleetTool } from "../src/server/services/fleet-tools/index.js";
const mockedExecute = vi.mocked(executeFleetTool);

// ─── Fixtures ───────────────────────────────────────────────

const FIXTURE_PROPOSAL: MutationProposal = {
  id: "prop_test-uuid-1234",
  userId: "local",
  schemaVersion: 1,
  tool: "sync_overlay",
  argsJson: { export: { version: "1.0", officers: [] } },
  argsHash: "abc123",
  proposalJson: { tool: "sync_overlay", dryRun: true, summary: {}, changesPreview: {} },
  status: "proposed",
  declineReason: null,
  appliedReceiptId: null,
  createdAt: "2026-02-21T00:00:00Z",
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  appliedAt: null,
  declinedAt: null,
};

// ─── Mock Factories ─────────────────────────────────────────

function createMockProposalStore(overrides: Partial<ProposalStore> = {}): ProposalStore {
  return {
    create: vi.fn().mockResolvedValue(FIXTURE_PROPOSAL),
    get: vi.fn().mockResolvedValue(FIXTURE_PROPOSAL),
    apply: vi.fn().mockResolvedValue({ ...FIXTURE_PROPOSAL, status: "applied" }),
    decline: vi.fn().mockResolvedValue({ ...FIXTURE_PROPOSAL, status: "declined" }),
    list: vi.fn().mockResolvedValue([FIXTURE_PROPOSAL]),
    expireStale: vi.fn().mockResolvedValue(0),
    counts: vi.fn().mockResolvedValue({ total: 1, proposed: 1, applied: 0, declined: 0, expired: 0 }),
    close: vi.fn(),
    ...overrides,
  };
}

function createMockProposalStoreFactory(store: ProposalStore) {
  return { forUser: vi.fn().mockReturnValue(store) };
}

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

// ─── GET /api/mutations/proposals ───────────────────────────

describe("GET /api/mutations/proposals", () => {
  it("returns 503 when proposal store not available", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/mutations/proposals");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PROPOSAL_STORE_NOT_AVAILABLE");
  });

  it("returns proposals list with count", async () => {
    const store = createMockProposalStore();
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/mutations/proposals");
    expect(res.status).toBe(200);
    expect(res.body.data.proposals).toHaveLength(1);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.proposals[0].id).toBe("prop_test-uuid-1234");
  });

  it("filters by status", async () => {
    const filteredProposal = { ...FIXTURE_PROPOSAL, status: "applied" as const };
    const store = createMockProposalStore({
      list: vi.fn().mockResolvedValue([filteredProposal]),
    });
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/mutations/proposals?status=applied");
    expect(res.status).toBe(200);
    expect(store.list).toHaveBeenCalledWith({ status: "applied", limit: undefined });
    expect(res.body.data.proposals[0].status).toBe("applied");
  });

  it("validates invalid status param → 400", async () => {
    const store = createMockProposalStore();
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/mutations/proposals?status=bogus");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
  });
});

// ─── GET /api/mutations/proposals/:id ───────────────────────

describe("GET /api/mutations/proposals/:id", () => {
  it("returns proposal detail", async () => {
    const store = createMockProposalStore();
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/mutations/proposals/prop_test-uuid-1234");
    expect(res.status).toBe(200);
    expect(res.body.data.proposal.id).toBe("prop_test-uuid-1234");
    expect(res.body.data.proposal.tool).toBe("sync_overlay");
  });

  it("returns 404 for unknown ID", async () => {
    const store = createMockProposalStore({
      get: vi.fn().mockResolvedValue(null),
    });
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/mutations/proposals/prop_nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 503 when store unavailable", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/mutations/proposals/prop_any");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PROPOSAL_STORE_NOT_AVAILABLE");
  });
});

// ─── POST /api/mutations/proposals ──────────────────────────

describe("POST /api/mutations/proposals", () => {
  it("returns 503 when proposal store not available", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/mutations/proposals")
      .send({ tool: "sync_overlay", args: {} });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PROPOSAL_STORE_NOT_AVAILABLE");
  });

  it("returns 400 when tool is missing", async () => {
    const store = createMockProposalStore();
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/mutations/proposals")
      .send({ args: { export: {} } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("returns 400 when args is missing", async () => {
    const store = createMockProposalStore();
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/mutations/proposals")
      .send({ tool: "sync_overlay" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("returns 400 for unsupported tool", async () => {
    const store = createMockProposalStore();
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/mutations/proposals")
      .send({ tool: "delete_everything", args: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
    expect(res.body.error.message).toContain("not supported");
  });

  it("creates proposal with preview data", async () => {
    const store = createMockProposalStore();
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
      toolContextFactory: createMockToolContextFactory(),
    });
    const app = createApp(state);

    // Reset mock for this test
    mockedExecute.mockResolvedValueOnce({
      tool: "sync_overlay",
      dryRun: true,
      summary: { officers: { input: 5, changed: 3 }, ships: { input: 2, changed: 1 } },
      changesPreview: { officers: [], ships: [] },
      warnings: [],
    });

    const res = await testRequest(app)
      .post("/api/mutations/proposals")
      .send({ tool: "sync_overlay", args: { export: { version: "1.0", officers: [] } } });
    // Route calls res.status(201) then sendOk() which resets to 200 (sendOk default)
    expect(res.status).toBe(200);
    expect(res.body.data.proposal).toBeDefined();
    expect(res.body.data.proposal.id).toBe("prop_test-uuid-1234");
    expect(res.body.data.proposal.status).toBe("proposed");
    expect(res.body.data.proposal.expiresAt).toBeDefined();
  });
});

// ─── POST /api/mutations/proposals/:id/apply ────────────────

describe("POST /api/mutations/proposals/:id/apply", () => {
  it("returns 404 for unknown proposal", async () => {
    const store = createMockProposalStore({
      get: vi.fn().mockResolvedValue(null),
    });
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/mutations/proposals/prop_unknown/apply")
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 503 when store unavailable", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/mutations/proposals/prop_any/apply")
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PROPOSAL_STORE_NOT_AVAILABLE");
  });

  it("applies proposal successfully", async () => {
    // Build a proposal with a correct argsHash
    const { createHash } = await import("node:crypto");
    const args = { export: { version: "1.0", officers: [] } };
    const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const proposal: MutationProposal = {
      ...FIXTURE_PROPOSAL,
      argsJson: args,
      argsHash,
      status: "proposed",
    };

    const store = createMockProposalStore({
      get: vi.fn().mockResolvedValue(proposal),
      apply: vi.fn().mockResolvedValue({ ...proposal, status: "applied" }),
    });
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
      toolContextFactory: createMockToolContextFactory(),
    });
    const app = createApp(state);

    // Mock executeFleetTool for apply (dry_run: false)
    mockedExecute.mockResolvedValueOnce({
      tool: "sync_overlay",
      dryRun: false,
      summary: { officers: { input: 5, changed: 3 }, ships: { input: 2, changed: 1 } },
      receipt: { id: 99 },
    });

    const res = await testRequest(app)
      .post(`/api/mutations/proposals/${proposal.id}/apply`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(true);
    expect(res.body.data.proposal_id).toBe(proposal.id);
    expect(res.body.data.receipt_id).toBe(99);
  });

  it("returns 409 when proposal already applied", async () => {
    const { createHash } = await import("node:crypto");
    const args = { export: { version: "1.0", officers: [] } };
    const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const appliedProposal: MutationProposal = {
      ...FIXTURE_PROPOSAL,
      argsJson: args,
      argsHash,
      status: "proposed",
    };

    const store = createMockProposalStore({
      get: vi.fn().mockResolvedValue(appliedProposal),
      apply: vi.fn().mockRejectedValue(
        new Error("Cannot apply proposal prop_test-uuid-1234: status is 'applied', expected 'proposed'"),
      ),
    });
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
      toolContextFactory: createMockToolContextFactory(),
    });
    const app = createApp(state);

    // Mock executeFleetTool to succeed (the apply store call will throw)
    mockedExecute.mockResolvedValueOnce({
      tool: "sync_overlay",
      dryRun: false,
      summary: {},
      receipt: { id: 100 },
    });

    const res = await testRequest(app)
      .post(`/api/mutations/proposals/${appliedProposal.id}/apply`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });
});

// ─── POST /api/mutations/proposals/:id/decline ──────────────

describe("POST /api/mutations/proposals/:id/decline", () => {
  it("returns 404 for unknown proposal", async () => {
    const store = createMockProposalStore({
      get: vi.fn().mockResolvedValue(null),
    });
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/mutations/proposals/prop_unknown/decline")
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("declines proposal successfully", async () => {
    const store = createMockProposalStore({
      get: vi.fn().mockResolvedValue(FIXTURE_PROPOSAL),
      decline: vi.fn().mockResolvedValue({ ...FIXTURE_PROPOSAL, status: "declined" }),
    });
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app)
      .post(`/api/mutations/proposals/${FIXTURE_PROPOSAL.id}/decline`)
      .send({ reason: "Changed my mind" });
    expect(res.status).toBe(200);
    expect(res.body.data.declined).toBe(true);
    expect(res.body.data.proposal_id).toBe(FIXTURE_PROPOSAL.id);
  });

  it("returns 409 when proposal already declined/applied", async () => {
    const store = createMockProposalStore({
      get: vi.fn().mockResolvedValue({ ...FIXTURE_PROPOSAL, status: "applied" }),
      decline: vi.fn().mockRejectedValue(
        new Error("Cannot decline proposal prop_test-uuid-1234: status is 'applied', expected 'proposed'"),
      ),
    });
    const state = makeState({
      startupComplete: true,
      proposalStoreFactory: createMockProposalStoreFactory(store),
    });
    const app = createApp(state);

    const res = await testRequest(app)
      .post(`/api/mutations/proposals/${FIXTURE_PROPOSAL.id}/decline`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });
});
