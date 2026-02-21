import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import { createOverlayStore, type OverlayStore } from "../src/server/stores/overlay-store.js";
import { createReceiptStore, type ReceiptStore } from "../src/server/stores/receipt-store.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";
import { makeState } from "./helpers/make-state.js";
import { createTestPool, truncatePublicTables, type Pool } from "./helpers/pg-test.js";
import { testRequest } from "./helpers/test-request.js";

const REF_DEFAULTS = {
  source: "test",
  sourceUrl: null,
  sourcePageId: null,
  sourceRevisionId: null,
  sourceRevisionTimestamp: null,
};

let pool: Pool;
let app: Express;
let overlayStore: OverlayStore;
let receiptStore: ReceiptStore;
let referenceStore: ReferenceStore;

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
    groupName: "Test",
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

function buildResolvedRows(level: number) {
  return [
    {
      rowIndex: 0,
      officerRefId: "kirk",
      officerOwned: true,
      officerLevel: level,
      officerRank: "4",
      officerPower: 9000,
    },
  ];
}

describe("Import commit safety", () => {
  it("returns 409 and requires approval for protected overwrites", async () => {
    await overlayStore.setOfficerOverlay({
      refId: "kirk",
      ownershipState: "owned",
      level: 30,
      rank: "5",
      power: 10000,
    });

    const res = await testRequest(app)
      .post("/api/import/commit")
      .send({
        resolvedRows: buildResolvedRows(20),
        unresolved: [],
        mapping: { officer: "kirk" },
        sourceMeta: { source: "test" },
        fileName: "sheet.csv",
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(res.body.error.detail.requiresApproval).toBe(true);
    expect(res.body.error.detail.overwriteCount).toBe(1);

    const persisted = await overlayStore.getOfficerOverlay("kirk");
    expect(persisted?.level).toBe(30);

    const receiptCounts = await receiptStore.counts();
    expect(receiptCounts.total).toBe(0);
  });

  it("applies overwrite when allowOverwrite is true", async () => {
    await overlayStore.setOfficerOverlay({
      refId: "kirk",
      ownershipState: "owned",
      level: 30,
      rank: "5",
      power: 10000,
    });

    const res = await testRequest(app)
      .post("/api/import/commit")
      .send({
        resolvedRows: buildResolvedRows(20),
        unresolved: [],
        mapping: { officer: "kirk" },
        sourceMeta: { source: "test" },
        fileName: "sheet.csv",
        allowOverwrite: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.requiresApproval).toBe(false);
    expect(res.body.data.summary.updated).toBe(1);

    const persisted = await overlayStore.getOfficerOverlay("kirk");
    expect(persisted?.level).toBe(20);
    expect(persisted?.rank).toBe("4");
    expect(persisted?.power).toBe(9000);

    const receiptCounts = await receiptStore.counts();
    expect(receiptCounts.total).toBe(1);
  });

  it("treats identical re-import as unchanged/idempotent", async () => {
    const first = await testRequest(app)
      .post("/api/import/commit")
      .send({
        resolvedRows: buildResolvedRows(20),
        unresolved: [],
        mapping: { officer: "kirk" },
        sourceMeta: { source: "test" },
        fileName: "sheet.csv",
      });

    expect(first.status).toBe(200);
    expect(first.body.data.summary.added).toBe(1);

    const second = await testRequest(app)
      .post("/api/import/commit")
      .send({
        resolvedRows: buildResolvedRows(20),
        unresolved: [],
        mapping: { officer: "kirk" },
        sourceMeta: { source: "test" },
        fileName: "sheet.csv",
      });

    expect(second.status).toBe(200);
    expect(second.body.data.summary.added).toBe(0);
    expect(second.body.data.summary.updated).toBe(0);
    expect(second.body.data.summary.unchanged).toBe(1);

    const receiptCounts = await receiptStore.counts();
    expect(receiptCounts.total).toBe(2);
  });

  it("rolls back all writes if commit fails mid-transaction", async () => {
    const res = await testRequest(app)
      .post("/api/import/commit")
      .send({
        resolvedRows: [
          {
            rowIndex: 0,
            officerRefId: "kirk",
            officerOwned: true,
            officerLevel: 20,
            officerRank: "4",
            officerPower: 9000,
            shipRefId: "enterprise",
            shipOwned: true,
            shipTier: 3,
            shipLevel: 25,
            shipPower: 2147483648,
          },
        ],
        unresolved: [],
        mapping: { officer: "kirk", ship: "enterprise" },
        sourceMeta: { source: "test" },
        fileName: "sheet.csv",
        allowOverwrite: true,
      });

    expect(res.status).toBe(500);

    const officer = await overlayStore.getOfficerOverlay("kirk");
    const ship = await overlayStore.getShipOverlay("enterprise");
    expect(officer).toBeNull();
    expect(ship).toBeNull();

    const receiptCounts = await receiptStore.counts();
    expect(receiptCounts.total).toBe(0);
  });
});