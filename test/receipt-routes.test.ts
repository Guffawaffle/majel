/**
 * receipt-routes.test.ts — Import Receipt API Route Tests (ADR-026)
 *
 * Tests validation branches in receipt routes.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import { createApp } from "../src/server/index.js";
import { makeState } from "./helpers/make-state.js";
import { createReceiptStore, type ReceiptStore } from "../src/server/stores/receipt-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
let store: ReceiptStore;

beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// makeState imported from ./helpers/make-state.js

describe("receipt routes", () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    store = await createReceiptStore(pool);
  });

  describe("GET /api/import/receipts", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      const res = await testRequest(app).get("/api/import/receipts");
      expect(res.status).toBe(503);
    });

    it("returns empty receipts list", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get("/api/import/receipts");
      expect(res.status).toBe(200);
      expect(res.body.data.receipts).toEqual([]);
      expect(res.body.data.count).toBe(0);
    });

    it("rejects invalid limit", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get("/api/import/receipts?limit=0");
      expect(res.status).toBe(400);
    });

    it("rejects limit > 200", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get("/api/import/receipts?limit=201");
      expect(res.status).toBe(400);
    });

    it("rejects invalid layer", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get("/api/import/receipts?layer=invalid");
      expect(res.status).toBe(400);
    });

    it("accepts valid layer filter", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get("/api/import/receipts?layer=reference");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/import/receipts/:id", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      const res = await testRequest(app).get("/api/import/receipts/1");
      expect(res.status).toBe(503);
    });

    it("rejects invalid ID", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get("/api/import/receipts/abc");
      expect(res.status).toBe(400);
    });

    it("returns 404 for nonexistent receipt", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get("/api/import/receipts/99999");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/import/receipts/:id/undo", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      const res = await testRequest(app).post("/api/import/receipts/1/undo");
      expect(res.status).toBe(503);
    });

    it("rejects invalid ID", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post("/api/import/receipts/abc/undo");
      expect(res.status).toBe(400);
    });

    it("returns 404 for nonexistent receipt", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post("/api/import/receipts/99999/undo");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/import/receipts/:id/resolve", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      const res = await testRequest(app).post("/api/import/receipts/1/resolve").send({ resolvedItems: [] });
      expect(res.status).toBe(503);
    });

    it("rejects invalid ID", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post("/api/import/receipts/abc/resolve").send({ resolvedItems: [] });
      expect(res.status).toBe(400);
    });

    it("rejects non-array resolvedItems", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post("/api/import/receipts/1/resolve").send({ resolvedItems: "not-an-array" });
      expect(res.status).toBe(400);
    });

    it("rejects resolvedItems with more than 500 entries", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const items = Array.from({ length: 501 }, (_, i) => ({ id: i }));
      const res = await testRequest(app).post("/api/import/receipts/1/resolve").send({ resolvedItems: items });
      expect(res.status).toBe(400);
    });

    it("rejects resolvedItems containing non-objects", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post("/api/import/receipts/1/resolve").send({ resolvedItems: ["not-an-object"] });
      expect(res.status).toBe(400);
    });

    it("returns 404 for nonexistent receipt with valid items", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post("/api/import/receipts/99999/resolve").send({ resolvedItems: [{ id: "x" }] });
      expect(res.status).toBe(404);
    });
  });
});
