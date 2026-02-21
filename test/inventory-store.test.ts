import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createInventoryStoreFactory } from "../src/server/stores/inventory-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe("InventoryStore", () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
  });

  it("upserts items and returns counts", async () => {
    const factory = await createInventoryStoreFactory(pool);
    const store = factory.forUser("u1");

    const result = await store.upsertItems({
      source: "sync",
      capturedAt: "2026-02-21T00:00:00Z",
      items: [
        { category: "ore", name: "Raw Ore", grade: null, quantity: 200.9, unit: "units" },
        { category: "gas", name: "Raw Gas", grade: "G3", quantity: 10, unit: "units" },
      ],
    });

    expect(result).toEqual({ upserted: 2, categories: 2 });

    const counts = await store.counts();
    expect(counts).toEqual({ items: 2, categories: 2 });

    const items = await store.listItems();
    expect(items[0].source).toBe("sync");
    expect(items.find((item) => item.name === "Raw Ore")?.quantity).toBe(200);
  });

  it("updates existing unique item key and supports filters", async () => {
    const factory = await createInventoryStoreFactory(pool);
    const store = factory.forUser("u1");

    await store.upsertItems({
      source: "sync",
      capturedAt: null,
      items: [
        { category: "ore", name: " Raw Ore ", grade: null, quantity: 20, unit: "u" },
        { category: "currency", name: "Latinum", grade: null, quantity: 5, unit: null },
      ],
    });

    await store.upsertItems({
      source: "sync2",
      capturedAt: null,
      items: [{ category: "ore", name: "Raw Ore", grade: null, quantity: -1, unit: "u" }],
    });

    const oreOnly = await store.listItems({ category: "ore" });
    expect(oreOnly).toHaveLength(1);
    expect(oreOnly[0].quantity).toBe(0);

    const qFilter = await store.listItems({ q: "lat" });
    expect(qFilter).toHaveLength(1);
    expect(qFilter[0].name).toBe("Latinum");
  });

  it("groups by category with totals and user isolation", async () => {
    const factory = await createInventoryStoreFactory(pool);
    const a = factory.forUser("u-a");
    const b = factory.forUser("u-b");

    await a.upsertItems({
      source: null,
      capturedAt: null,
      items: [
        { category: "ore", name: "Raw Ore", grade: null, quantity: 10, unit: null },
        { category: "ore", name: "Refined Ore", grade: "G3", quantity: 2, unit: null },
        { category: "gas", name: "Raw Gas", grade: null, quantity: 8, unit: null },
      ],
    });

    await b.upsertItems({
      source: null,
      capturedAt: null,
      items: [{ category: "currency", name: "Credits", grade: null, quantity: 1, unit: null }],
    });

    const grouped = await a.listByCategory();
    const ore = grouped.find((entry) => entry.category === "ore");
    expect(ore?.totals.itemCount).toBe(2);
    expect(ore?.totals.totalQuantity).toBe(12);

    expect((await a.counts()).items).toBe(3);
    expect((await b.counts()).items).toBe(1);
  });
});
