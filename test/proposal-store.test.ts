import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createProposalStoreFactory } from "../src/server/stores/proposal-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function pastIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("ProposalStore", () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
  });

  it("creates, retrieves, and lists proposals", async () => {
    const factory = await createProposalStoreFactory(pool);
    const store = factory.forUser("u1");

    const created = await store.create({
      tool: "sync_overlay",
      argsJson: { dryRun: true },
      argsHash: "hash-1",
      proposalJson: { summary: "preview" },
      expiresAt: futureIso(15),
    });

    expect(created.id.startsWith("prop_")).toBe(true);
    expect(created.status).toBe("proposed");

    const fetched = await store.get(created.id);
    expect(fetched?.id).toBe(created.id);

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);

    const counts = await store.counts();
    expect(counts).toEqual({ total: 1, proposed: 1, applied: 0, declined: 0, expired: 0 });
  });

  it("applies a proposed record and sets receipt id", async () => {
    const factory = await createProposalStoreFactory(pool);
    const store = factory.forUser("u1");
    const created = await store.create({
      tool: "sync_overlay",
      argsJson: {},
      argsHash: "hash-apply",
      proposalJson: {},
      expiresAt: futureIso(10),
    });

    const applied = await store.apply(created.id, 42);
    expect(applied.status).toBe("applied");
    expect(applied.appliedReceiptId).toBe(42);
    expect(applied.appliedAt).toBeTruthy();

    await expect(store.decline(created.id, "too late")).rejects.toThrow("expected 'proposed'");
  });

  it("declines a proposed record with reason", async () => {
    const factory = await createProposalStoreFactory(pool);
    const store = factory.forUser("u1");
    const created = await store.create({
      tool: "sync_overlay",
      argsJson: {},
      argsHash: "hash-decline",
      proposalJson: {},
      expiresAt: futureIso(10),
    });

    const declined = await store.decline(created.id, "operator cancelled");
    expect(declined.status).toBe("declined");
    expect(declined.declineReason).toBe("operator cancelled");
    expect(declined.declinedAt).toBeTruthy();

    await expect(store.apply(created.id, 11)).rejects.toThrow("expected 'proposed'");
  });

  it("marks expired on apply when expiresAt is in the past", async () => {
    const factory = await createProposalStoreFactory(pool);
    const store = factory.forUser("u1");
    const created = await store.create({
      tool: "sync_overlay",
      argsJson: {},
      argsHash: "hash-expired",
      proposalJson: {},
      expiresAt: pastIso(1),
    });

    await expect(store.apply(created.id, 12)).rejects.toThrow("proposal has expired");

    const expired = await store.get(created.id);
    expect(expired?.status).toBe("expired");
  });

  it("expires stale proposals in batch", async () => {
    const factory = await createProposalStoreFactory(pool);
    const store = factory.forUser("u1");

    await store.create({
      tool: "sync_overlay",
      argsJson: {},
      argsHash: "hash-old",
      proposalJson: {},
      expiresAt: pastIso(5),
    });
    await store.create({
      tool: "sync_overlay",
      argsJson: {},
      argsHash: "hash-new",
      proposalJson: {},
      expiresAt: futureIso(5),
    });

    const expiredCount = await store.expireStale();
    expect(expiredCount).toBe(1);

    const counts = await store.counts();
    expect(counts.expired).toBe(1);
    expect(counts.proposed).toBe(1);
  });

  it("enforces user isolation", async () => {
    const factory = await createProposalStoreFactory(pool);
    const a = factory.forUser("u-a");
    const b = factory.forUser("u-b");

    const created = await a.create({
      tool: "sync_overlay",
      argsJson: {},
      argsHash: "hash-a",
      proposalJson: {},
      expiresAt: futureIso(10),
    });

    expect(await b.get(created.id)).toBeNull();
    expect(await b.list()).toHaveLength(0);
    await expect(b.apply(created.id, 7)).rejects.toThrow("not found");
  });
});
