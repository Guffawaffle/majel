/**
 * receipt-store.test.ts — ADR-026 Import Receipt Data Layer Tests
 *
 * Integration tests against live PostgreSQL (docker-compose).
 * Tests receipt CRUD, undo (with dependency check), and resolve queue persistence (A4).
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createReceiptStore, type ReceiptStore } from "../src/server/stores/receipt-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// ─── Test Helpers ───────────────────────────────────────────────

const REF_DEFAULTS = {
  source: "test", sourceUrl: null, sourcePageId: null,
  sourceRevisionId: null, sourceRevisionTimestamp: null,
};

// ═══════════════════════════════════════════════════════════════
// Receipt CRUD
// ═══════════════════════════════════════════════════════════════

describe("ReceiptStore — CRUD", () => {
  let store: ReceiptStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    store = await createReceiptStore(pool);
  });

  it("creates a receipt", async () => {
    const receipt = await store.createReceipt({
      sourceType: "auto_seed",
      sourceMeta: { officers: 277, ships: 75 },
      layer: "reference",
      changeset: { added: [{ type: "officers", count: 277 }] },
    });
    expect(receipt.id).toBeGreaterThan(0);
    expect(receipt.sourceType).toBe("auto_seed");
    expect(receipt.layer).toBe("reference");
    expect(receipt.sourceMeta).toEqual({ officers: 277, ships: 75 });
    expect(receipt.changeset.added).toHaveLength(1);
    expect(receipt.createdAt).toBeTruthy();
  });

  it("creates a receipt with all source types", async () => {
    const types = ["catalog_clicks", "guided_setup", "file_import", "community_export", "sandbox", "auto_seed"] as const;
    for (const sourceType of types) {
      const receipt = await store.createReceipt({ sourceType, layer: "ownership" });
      expect(receipt.sourceType).toBe(sourceType);
    }
  });

  it("creates a receipt with all layers", async () => {
    const layers = ["reference", "ownership", "composition"] as const;
    for (const layer of layers) {
      const receipt = await store.createReceipt({ sourceType: "catalog_clicks", layer });
      expect(receipt.layer).toBe(layer);
    }
  });

  it("gets a receipt by id", async () => {
    const created = await store.createReceipt({
      sourceType: "file_import",
      sourceMeta: { filename: "roster.csv" },
      mapping: { col1: "name", col2: "rarity" },
      layer: "ownership",
      changeset: { added: [{ id: "kirk" }] },
      inverse: { removed: [{ id: "kirk" }] },
      unresolved: [{ name: "Kerk", confidence: 0.6 }],
    });
    const retrieved = await store.getReceipt(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.sourceType).toBe("file_import");
    expect(retrieved!.mapping).toEqual({ col1: "name", col2: "rarity" });
    expect(retrieved!.unresolved).toEqual([{ name: "Kerk", confidence: 0.6 }]);
  });

  it("returns null for nonexistent receipt", async () => {
    expect(await store.getReceipt(99999)).toBeNull();
  });

  it("lists receipts ordered by created_at DESC", async () => {
    await store.createReceipt({ sourceType: "auto_seed", layer: "reference" });
    await store.createReceipt({ sourceType: "catalog_clicks", layer: "ownership" });
    await store.createReceipt({ sourceType: "file_import", layer: "ownership" });
    const all = await store.listReceipts();
    expect(all).toHaveLength(3);
    // Most recent first
    expect(all[0].sourceType).toBe("file_import");
  });

  it("lists receipts with limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.createReceipt({ sourceType: "catalog_clicks", layer: "ownership" });
    }
    const limited = await store.listReceipts(2);
    expect(limited).toHaveLength(2);
  });

  it("lists receipts filtered by layer", async () => {
    await store.createReceipt({ sourceType: "auto_seed", layer: "reference" });
    await store.createReceipt({ sourceType: "catalog_clicks", layer: "ownership" });
    await store.createReceipt({ sourceType: "catalog_clicks", layer: "ownership" });
    const ownershipOnly = await store.listReceipts(undefined, "ownership");
    expect(ownershipOnly).toHaveLength(2);
    expect(ownershipOnly.every(r => r.layer === "ownership")).toBe(true);
  });

  it("counts receipts", async () => {
    expect((await store.counts()).total).toBe(0);
    await store.createReceipt({ sourceType: "auto_seed", layer: "reference" });
    await store.createReceipt({ sourceType: "catalog_clicks", layer: "ownership" });
    expect((await store.counts()).total).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// Undo
// ═══════════════════════════════════════════════════════════════

describe("ReceiptStore — Undo", () => {
  let store: ReceiptStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    store = await createReceiptStore(pool);
  });

  it("returns inverse for ownership receipt", async () => {
    const receipt = await store.createReceipt({
      sourceType: "catalog_clicks",
      layer: "ownership",
      changeset: { updated: [{ id: "kirk", ownershipState: "owned" }] },
      inverse: { updated: [{ id: "kirk", ownershipState: "unknown" }] },
    });
    const result = await store.undoReceipt(receipt.id);
    expect(result.success).toBe(true);
    expect(result.inverse).toEqual({ updated: [{ id: "kirk", ownershipState: "unknown" }] });
  });

  it("returns not found for nonexistent receipt", async () => {
    const result = await store.undoReceipt(99999);
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("blocks undo of reference receipt with composition dependencies", async () => {
    // Need reference + crew stores to test dependency check
    const refStore = await createReferenceStore(pool);
    const crewStore = await createCrewStore(pool);

    // Seed an officer and create a bridge core using it
    await refStore.upsertOfficer({
      id: "kirk", name: "Kirk", rarity: "Epic", groupName: "TOS",
      captainManeuver: null, officerAbility: null, belowDeckAbility: null,
      ...REF_DEFAULTS,
    });
    await crewStore.createBridgeCore("TOS Core", [
      { officerId: "kirk", slot: "captain" },
    ]);

    // Create a reference receipt that "added" kirk
    const receipt = await store.createReceipt({
      sourceType: "auto_seed",
      layer: "reference",
      changeset: { added: [{ id: "kirk" }] },
      inverse: { removed: [{ id: "kirk" }] },
    });

    const result = await store.undoReceipt(receipt.id);
    expect(result.success).toBe(false);
    expect(result.message).toContain("composition");
  });

  it("allows undo of reference receipt without dependencies", async () => {
    await createReferenceStore(pool);
    await createCrewStore(pool);

    const receipt = await store.createReceipt({
      sourceType: "auto_seed",
      layer: "reference",
      changeset: { added: [{ id: "nobody" }] },
      inverse: { removed: [{ id: "nobody" }] },
    });

    const result = await store.undoReceipt(receipt.id);
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Resolve Queue Persistence (ADR-026a A4)
// ═══════════════════════════════════════════════════════════════

describe("ReceiptStore — Resolve Queue (A4)", () => {
  let store: ReceiptStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    store = await createReceiptStore(pool);
  });

  it("stores unresolved items in receipt", async () => {
    const receipt = await store.createReceipt({
      sourceType: "file_import",
      layer: "ownership",
      changeset: { added: [{ id: "kirk" }, { id: "spock" }] },
      unresolved: [
        { name: "Kerk", confidence: 0.6 },
        { name: "Spoke", confidence: 0.4 },
      ],
    });
    expect(receipt.unresolved).toHaveLength(2);
  });

  it("resolves items from unresolved → changeset", async () => {
    const receipt = await store.createReceipt({
      sourceType: "file_import",
      layer: "ownership",
      changeset: { added: [{ id: "kirk" }] },
      unresolved: [
        { name: "Kerk", confidence: 0.6 },
        { name: "Spoke", confidence: 0.4 },
      ],
    });

    // Resolve "Kerk" (mark it as handled)
    const updated = await store.resolveReceiptItems(receipt.id, [
      { name: "Kerk", confidence: 0.6 },
    ]);

    // Kerk moved to changeset.added, Spoke remains unresolved
    expect(updated.changeset.added).toHaveLength(2); // kirk + Kerk
    expect(updated.unresolved).toHaveLength(1);
    expect(updated.unresolved![0]).toEqual({ name: "Spoke", confidence: 0.4 });
  });

  it("clears unresolved when all items resolved", async () => {
    const receipt = await store.createReceipt({
      sourceType: "file_import",
      layer: "ownership",
      changeset: { added: [] },
      unresolved: [{ name: "Kerk", confidence: 0.6 }],
    });

    const updated = await store.resolveReceiptItems(receipt.id, [
      { name: "Kerk", confidence: 0.6 },
    ]);

    expect(updated.unresolved).toBeNull();
    expect(updated.changeset.added).toHaveLength(1);
  });

  it("throws for nonexistent receipt", async () => {
    await expect(
      store.resolveReceiptItems(99999, []),
    ).rejects.toThrow("not found");
  });
});
