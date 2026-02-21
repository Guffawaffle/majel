/**
 * receipt-routes.test.ts — Import Receipt API Route Tests (ADR-026)
 *
 * Tests validation branches in receipt routes.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import { createApp } from "../src/server/index.js";
import { makeState } from "./helpers/make-state.js";
import { createReceiptStore, type ReceiptStore } from "../src/server/stores/receipt-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import {
  BASE_LIMIT_QUERY_CASES,
  BASE_RECEIPT_ID_CASES,
  BASE_RECEIPT_RESOLVE_PAYLOAD_CASES,
  BASE_RECEIPT_STORE_UNAVAILABLE_CASES,
} from "./helpers/data-route-base.js";
import { expectRouteErrorCase } from "./helpers/route-cases.js";

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
      await expectRouteErrorCase(app, BASE_RECEIPT_STORE_UNAVAILABLE_CASES[0]);
    });

    it("returns empty receipts list", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get("/api/import/receipts");
      expect(res.status).toBe(200);
      expect(res.body.data.receipts).toEqual([]);
      expect(res.body.data.count).toBe(0);
    });

    it.each(BASE_LIMIT_QUERY_CASES)("validates query param: $name", async ({ query, expectedStatus }) => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get(`/api/import/receipts?${query}`);
      expect(res.status).toBe(expectedStatus);
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

    it("accepts limit boundary of 200", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get("/api/import/receipts?limit=200");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/import/receipts/:id", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      await expectRouteErrorCase(app, BASE_RECEIPT_STORE_UNAVAILABLE_CASES[1]);
    });

    it.each(BASE_RECEIPT_ID_CASES)("validates receipt id: $name", async ({ id, expectedStatus }) => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).get(`/api/import/receipts/${id}`);
      expect(res.status).toBe(expectedStatus);
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
      await expectRouteErrorCase(app, BASE_RECEIPT_STORE_UNAVAILABLE_CASES[2]);
    });

    it.each(BASE_RECEIPT_ID_CASES)("validates ID: $name", async ({ id, expectedStatus }) => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post(`/api/import/receipts/${id}/undo`);
      expect(res.status).toBe(expectedStatus);
    });

    it("returns 404 for nonexistent receipt", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post("/api/import/receipts/99999/undo");
      expect(res.status).toBe(404);
    });

    it("returns 503 for composition undo when pool not available", async () => {
      const receipt = await store.createReceipt({
        sourceType: "file_import",
        layer: "composition",
        inverse: { removed: [{ entityType: "loadout", id: 1 }] },
      });
      const app = createApp(makeState({ receiptStore: store, pool: undefined }));
      const res = await testRequest(app).post(`/api/import/receipts/${receipt.id}/undo`);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("CREW_STORE_NOT_AVAILABLE");
    });
  });

  describe("POST /api/import/receipts/:id/resolve", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      await expectRouteErrorCase(app, BASE_RECEIPT_STORE_UNAVAILABLE_CASES[3]);
    });

    it.each(BASE_RECEIPT_ID_CASES)("validates ID: $name", async ({ id, expectedStatus }) => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post(`/api/import/receipts/${id}/resolve`).send({ resolvedItems: [] });
      expect(res.status).toBe(expectedStatus);
    });

    it.each(BASE_RECEIPT_RESOLVE_PAYLOAD_CASES)("validates payload: $name", async ({ payload, expectedStatus, expectedMessageFragment }) => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post("/api/import/receipts/1/resolve").send(payload);
      expect(res.status).toBe(expectedStatus);
      if (expectedMessageFragment) {
        expect(String(res.body.error.message)).toContain(expectedMessageFragment);
      }
    });

    it("accepts resolvedItems with exactly 500 entries", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const receipt = await store.createReceipt({ sourceType: "file_import", layer: "ownership", unresolved: [{ id: "x" }] });
      const items = Array.from({ length: 500 }, (_, i) => ({ id: `r-${i}` }));
      const res = await testRequest(app).post(`/api/import/receipts/${receipt.id}/resolve`).send({ resolvedItems: items });
      expect(res.status).toBe(200);
    });

    it("returns 404 for nonexistent receipt with valid items", async () => {
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post("/api/import/receipts/99999/resolve").send({ resolvedItems: [{ id: "x" }] });
      expect(res.status).toBe(404);
    });

    it("returns 500 when resolve throws unexpected error", async () => {
      const receipt = await store.createReceipt({ sourceType: "file_import", layer: "ownership", unresolved: [] });
      const spy = vi.spyOn(store, "resolveReceiptItems").mockRejectedValueOnce(new Error("boom"));
      const app = createApp(makeState({ receiptStore: store }));
      const res = await testRequest(app).post(`/api/import/receipts/${receipt.id}/resolve`).send({ resolvedItems: [] });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");
      expect(res.body.error.message).toContain("boom");
      spy.mockRestore();
    });
  });
});
