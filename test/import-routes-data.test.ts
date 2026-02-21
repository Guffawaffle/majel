import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import ExcelJS from "exceljs";
import { createApp } from "../src/server/index.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";
import { createOverlayStore, type OverlayStore } from "../src/server/stores/overlay-store.js";
import { createReceiptStore, type ReceiptStore } from "../src/server/stores/receipt-store.js";
import { makeState } from "./helpers/make-state.js";
import { createTestPool, truncatePublicTables, type Pool } from "./helpers/pg-test.js";
import { testRequest } from "./helpers/test-request.js";
import {
  BASE_IMPORT_COMMIT_PAYLOAD_CASES,
  BASE_IMPORT_MAP_PAYLOAD_CASES,
  baseImportParsePayloadCases,
} from "./helpers/data-route-base.js";

const REF_DEFAULTS = {
  source: "test",
  sourceUrl: null,
  sourcePageId: null,
  sourceRevisionId: null,
  sourceRevisionTimestamp: null,
};

let pool: Pool;
let app: Express;
let referenceStore: ReferenceStore;
let overlayStore: OverlayStore;
let receiptStore: ReceiptStore;

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

function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

const IMPORT_PARSE_CASES = baseImportParsePayloadCases(toBase64);
const IMPORT_MAP_CASES = BASE_IMPORT_MAP_PAYLOAD_CASES;
const IMPORT_COMMIT_CASES = BASE_IMPORT_COMMIT_PAYLOAD_CASES;

describe("Import routes — data interactions", () => {
  it("POST /api/import/analyze accepts xlsx format", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("First");
    sheet.addRow(["Officer", "Level"]);
    sheet.addRow(["Kirk", "20"]);
    const xlsxBuffer = await workbook.xlsx.writeBuffer();

    const res = await testRequest(app)
      .post("/api/import/analyze")
      .send({
        fileName: "fleet.xlsx",
        contentBase64: Buffer.from(xlsxBuffer).toString("base64"),
        format: "xlsx",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.analysis.format).toBe("xlsx");
  });

  it("POST /api/import/parse parses csv payload", async () => {
    const csv = "Officer,Level\nKirk,20\n";
    const res = await testRequest(app)
      .post("/api/import/parse")
      .send({
        fileName: "fleet.csv",
        contentBase64: toBase64(csv),
        format: "csv",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.parsed.headers).toEqual(["Officer", "Level"]);
    expect(res.body.data.parsed.rowCount).toBe(1);
    expect(res.body.data.parsed.rows[0]).toEqual(["Kirk", "20"]);
  });

  it("POST /api/import/parse parses tsv payload", async () => {
    const tsv = "Officer\tLevel\nKirk\t20\n";
    const res = await testRequest(app)
      .post("/api/import/parse")
      .send({
        fileName: "fleet.tsv",
        contentBase64: toBase64(tsv),
        format: "tsv",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.parsed.headers).toEqual(["Officer", "Level"]);
    expect(res.body.data.parsed.rowCount).toBe(1);
    expect(res.body.data.parsed.rows[0]).toEqual(["Kirk", "20"]);
  });

  it("POST /api/import/parse parses first sheet from xlsx payload", async () => {
    const workbook = new ExcelJS.Workbook();
    const firstSheet = workbook.addWorksheet("First");
    firstSheet.addRow(["Officer", "Level"]);
    firstSheet.addRow(["Kirk", "20"]);
    const secondSheet = workbook.addWorksheet("Second");
    secondSheet.addRow(["Officer", "Level"]);
    secondSheet.addRow(["Spock", "25"]);
    const xlsxBuffer = await workbook.xlsx.writeBuffer();

    const xlsxBase64 = Buffer.from(xlsxBuffer).toString("base64");

    const res = await testRequest(app)
      .post("/api/import/parse")
      .send({
        fileName: "fleet.xlsx",
        contentBase64: xlsxBase64,
        format: "xlsx",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.parsed.headers).toEqual(["Officer", "Level"]);
    expect(res.body.data.parsed.rowCount).toBe(1);
    expect(res.body.data.parsed.rows[0]).toEqual(["Kirk", "20"]);
  });

  it.each(IMPORT_PARSE_CASES)("POST /api/import/parse validates payload: $name", async ({ payload, expectedStatus, expectedMessageFragment }) => {
    const res = await testRequest(app)
      .post("/api/import/parse")
      .send(payload);

    expect(res.status).toBe(expectedStatus);
    if (expectedMessageFragment) {
      expect(res.body.error.message).toContain(expectedMessageFragment);
    }
  });

  it("POST /api/import/map maps typed fields from parsed rows", async () => {
    const res = await testRequest(app)
      .post("/api/import/map")
      .send({
        headers: ["Officer", "Owned", "Power"],
        rows: [["Kirk", "yes", "9,000"]],
        mapping: {
          Officer: "officer.name",
          Owned: "officer.owned",
          Power: "officer.power",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.summary.rowCount).toBe(1);
    expect(res.body.data.mappedRows[0]).toMatchObject({
      rowIndex: 0,
      officerName: "Kirk",
      officerOwned: true,
      officerPower: 9000,
    });
  });

  it.each(IMPORT_MAP_CASES)("POST /api/import/map validates payload shape: $name", async ({ payload, expectedStatus, expectedMessageFragment }) => {
    const res = await testRequest(app)
      .post("/api/import/map")
      .send(payload);

    expect(res.status).toBe(expectedStatus);
    if (expectedMessageFragment) {
      expect(res.body.error.message).toContain(expectedMessageFragment);
    }
  });

  it("POST /api/import/resolve resolves known refs and reports unresolved", async () => {
    const res = await testRequest(app)
      .post("/api/import/resolve")
      .send({
        mappedRows: [
          { rowIndex: 0, officerName: "Kirk", shipName: "Enterprise" },
          { rowIndex: 1, officerName: "Unknown", shipName: "UnknownShip" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.summary.rows).toBe(2);
    expect(res.body.data.summary.unresolved).toBe(2);
    expect(res.body.data.resolvedRows[0].officerRefId).toBe("kirk");
    expect(res.body.data.resolvedRows[0].shipRefId).toBe("enterprise");

    const unresolved = res.body.data.unresolved as Array<Record<string, unknown>>;
    expect(unresolved).toHaveLength(2);
    expect(unresolved[0].entityType).toBe("officer");
    expect(unresolved[1].entityType).toBe("ship");
  });

  it("POST /api/import/resolve rejects non-array mappedRows", async () => {
    const res = await testRequest(app)
      .post("/api/import/resolve")
      .send({ mappedRows: "not-an-array" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
  });

  it("POST /api/import/resolve enforces MAX_IMPORT_ROWS limit", async () => {
    const mappedRows = Array.from({ length: 10001 }, () => ({}));
    const res = await testRequest(app)
      .post("/api/import/resolve")
      .send({ mappedRows });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
    expect(res.body.error.message).toContain("10000 or fewer");
  });

  it("POST /api/import/commit rejects unknown reference IDs", async () => {
    const res = await testRequest(app)
      .post("/api/import/commit")
      .send({
        resolvedRows: [
          {
            rowIndex: 0,
            officerRefId: "missing-officer",
            officerOwned: true,
          },
        ],
        unresolved: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
    expect(res.body.error.message).toContain("Unknown reference IDs");
  });

  it.each(IMPORT_COMMIT_CASES)("POST /api/import/commit validates payload: $name", async ({ payload, expectedStatus, expectedMessageFragment }) => {
    const res = await testRequest(app)
      .post("/api/import/commit")
      .send(payload);

    expect(res.status).toBe(expectedStatus);
    if (expectedMessageFragment) {
      expect(res.body.error.message).toContain(expectedMessageFragment);
    }
  });

  it("POST /api/import/commit returns 503 when pool not available", async () => {
    const noPoolApp = createApp(
      makeState({
        pool: undefined,
        referenceStore,
        overlayStore,
        receiptStore,
        startupComplete: true,
      }),
    );

    const res = await testRequest(noPoolApp)
      .post("/api/import/commit")
      .send({ resolvedRows: [], unresolved: [] });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("OVERLAY_STORE_NOT_AVAILABLE");
  });

  it("POST /api/import/commit returns 503 when reference store not available", async () => {
    const noReferenceApp = createApp(
      makeState({
        pool,
        referenceStore: null,
        overlayStore,
        receiptStore,
        startupComplete: true,
      }),
    );

    const res = await testRequest(noReferenceApp)
      .post("/api/import/commit")
      .send({ resolvedRows: [], unresolved: [] });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("REFERENCE_STORE_NOT_AVAILABLE");
  });
});
