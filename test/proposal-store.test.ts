/**
 * proposal-store.test.ts — Unit tests for ProposalStore interface & types (ADR-026b, #93 Phase 5)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Since ProposalStore uses PostgreSQL with RLS, integration testing requires
 * a real database. These tests verify the module's type exports and interface
 * shape. Full integration coverage lives in api.test.ts and proposals.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  ProposalStore,
  ProposalStatus,
  MutationProposal,
  CreateProposalInput,
} from "../src/server/stores/proposal-store.js";

// ─── Mock Store Factory ─────────────────────────────────────

const FIXTURE_PROPOSAL: MutationProposal = {
  id: "prop_test-uuid-1234",
  userId: "test-user",
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

// ─── Type Shape Tests ───────────────────────────────────────

describe("Proposal store types", () => {
  it("ProposalStatus union accepts valid values", () => {
    const statuses: ProposalStatus[] = ["proposed", "applied", "declined", "expired"];
    expect(statuses).toHaveLength(4);
    // TypeScript compilation alone proves the union is correct;
    // this runtime assertion confirms we can assign all four.
    for (const s of statuses) {
      expect(typeof s).toBe("string");
    }
  });

  it("MutationProposal has all required fields", () => {
    const proposal: MutationProposal = FIXTURE_PROPOSAL;
    const requiredKeys: (keyof MutationProposal)[] = [
      "id", "userId", "schemaVersion", "tool",
      "argsJson", "argsHash", "proposalJson", "status",
      "declineReason", "appliedReceiptId",
      "createdAt", "expiresAt", "appliedAt", "declinedAt",
    ];
    for (const key of requiredKeys) {
      expect(key in proposal).toBe(true);
    }
  });

  it("CreateProposalInput has required fields", () => {
    const input: CreateProposalInput = {
      tool: "sync_overlay",
      argsJson: { export: {} },
      argsHash: "hash123",
      proposalJson: { tool: "sync_overlay" },
      expiresAt: new Date().toISOString(),
    };
    const requiredKeys: (keyof CreateProposalInput)[] = [
      "tool", "argsJson", "argsHash", "proposalJson", "expiresAt",
    ];
    for (const key of requiredKeys) {
      expect(key in input).toBe(true);
    }
  });
});

// ─── Mock Store Shape Tests ─────────────────────────────────

describe("ProposalStore mock interface", () => {
  it("mock store implements all interface methods", () => {
    const store = createMockProposalStore();
    expect(typeof store.create).toBe("function");
    expect(typeof store.get).toBe("function");
    expect(typeof store.apply).toBe("function");
    expect(typeof store.decline).toBe("function");
    expect(typeof store.list).toBe("function");
    expect(typeof store.expireStale).toBe("function");
    expect(typeof store.counts).toBe("function");
    expect(typeof store.close).toBe("function");
  });

  it("create returns a MutationProposal", async () => {
    const store = createMockProposalStore();
    const result = await store.create({
      tool: "sync_overlay",
      argsJson: {},
      argsHash: "hash",
      proposalJson: {},
      expiresAt: new Date().toISOString(),
    });
    expect(result.id).toBe(FIXTURE_PROPOSAL.id);
    expect(result.status).toBe("proposed");
  });

  it("get returns a proposal or null", async () => {
    const store = createMockProposalStore();
    const result = await store.get("prop_test-uuid-1234");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("prop_test-uuid-1234");
  });

  it("get returns null for unknown id", async () => {
    const store = createMockProposalStore({
      get: vi.fn().mockResolvedValue(null),
    });
    const result = await store.get("prop_unknown");
    expect(result).toBeNull();
  });

  it("apply returns a proposal with applied status", async () => {
    const store = createMockProposalStore();
    const result = await store.apply("prop_test-uuid-1234", 42);
    expect(result.status).toBe("applied");
  });

  it("decline returns a proposal with declined status", async () => {
    const store = createMockProposalStore();
    const result = await store.decline("prop_test-uuid-1234", "Not needed");
    expect(result.status).toBe("declined");
  });

  it("list returns an array of proposals", async () => {
    const store = createMockProposalStore();
    const result = await store.list();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("list with status filter calls through", async () => {
    const listFn = vi.fn().mockResolvedValue([]);
    const store = createMockProposalStore({ list: listFn });
    await store.list({ status: "applied" });
    expect(listFn).toHaveBeenCalledWith({ status: "applied" });
  });

  it("expireStale returns count of expired proposals", async () => {
    const store = createMockProposalStore();
    const result = await store.expireStale();
    expect(result).toBe(0);
  });

  it("counts returns aggregated counts", async () => {
    const store = createMockProposalStore();
    const result = await store.counts();
    expect(result).toEqual({ total: 1, proposed: 1, applied: 0, declined: 0, expired: 0 });
  });

  it("overrides are applied correctly", async () => {
    const store = createMockProposalStore({
      counts: vi.fn().mockResolvedValue({ total: 5, proposed: 2, applied: 2, declined: 1, expired: 0 }),
    });
    const result = await store.counts();
    expect(result.total).toBe(5);
  });
});
