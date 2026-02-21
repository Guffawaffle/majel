import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/index.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";
import { createCrewStore, type CrewStore } from "../src/server/stores/crew-store.js";
import { createReceiptStore, type ReceiptStore } from "../src/server/stores/receipt-store.js";
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
let referenceStore: ReferenceStore;
let crewStore: CrewStore;
let receiptStore: ReceiptStore;

beforeAll(async () => {
  pool = createTestPool();
  referenceStore = await createReferenceStore(pool);
  crewStore = await createCrewStore(pool);
  receiptStore = await createReceiptStore(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncatePublicTables(pool);

  await referenceStore.upsertOfficer({
    id: "kirk",
    name: "Kirk",
    rarity: "Epic",
    groupName: "Enterprise",
    captainManeuver: "Boldly Go",
    officerAbility: null,
    belowDeckAbility: null,
    faction: { id: 1, name: "Federation" },
    ...REF_DEFAULTS,
  });
  await referenceStore.upsertOfficer({
    id: "spock",
    name: "Spock",
    rarity: "Epic",
    groupName: "Enterprise",
    captainManeuver: "Logical",
    officerAbility: null,
    belowDeckAbility: null,
    faction: { id: 1, name: "Federation" },
    ...REF_DEFAULTS,
  });
  await referenceStore.upsertOfficer({
    id: "mccoy",
    name: "McCoy",
    rarity: "Rare",
    groupName: "Enterprise",
    captainManeuver: null,
    officerAbility: null,
    belowDeckAbility: null,
    faction: { id: 1, name: "Federation" },
    ...REF_DEFAULTS,
  });

  await referenceStore.upsertShip({
    id: "enterprise",
    name: "USS Enterprise",
    shipClass: "Explorer",
    faction: "Federation",
    tier: 5,
    grade: null,
    rarity: "Epic",
    ...REF_DEFAULTS,
  });
});

describe("Import composition inference", () => {
  it("creates composition entities and a composition-layer receipt", async () => {
    const ownershipReceipt = await receiptStore.createReceipt({
      sourceType: "file_import",
      layer: "ownership",
      sourceMeta: { fileName: "fleet.csv" },
      changeset: { updated: [{ id: "kirk" }] },
      inverse: { updated: [{ id: "kirk" }] },
    });

    const app = createApp(
      makeState({
        pool,
        startupComplete: true,
        referenceStore,
        crewStore,
        receiptStore,
      }),
    );

    const res = await testRequest(app)
      .post("/api/import/composition/commit")
      .send({
        sourceReceiptId: ownershipReceipt.id,
        bridgeCores: [
          {
            key: "core-enterprise",
            name: "Kirk Trio",
            members: [
              { officerId: "kirk", slot: "captain" },
              { officerId: "spock", slot: "bridge_1" },
              { officerId: "mccoy", slot: "bridge_2" },
            ],
          },
        ],
        belowDeckPolicies: [
          {
            key: "policy-combat",
            name: "Combat BD",
            mode: "stats_then_bda",
            spec: { prefer_modifiers: ["attack", "critical_damage"] },
          },
        ],
        loadouts: [
          {
            name: "Enterprise Combat",
            shipId: "enterprise",
            bridgeCoreKey: "core-enterprise",
            belowDeckPolicyKey: "policy-combat",
            intentKeys: ["combat"],
            tags: ["import-inferred"],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.receipt.id).toBeTypeOf("number");
    expect(res.body.data.summary).toEqual({ bridgeCores: 1, belowDeckPolicies: 1, loadouts: 1 });

    const cores = await crewStore.listBridgeCores();
    const policies = await crewStore.listBelowDeckPolicies();
    const loadouts = await crewStore.listLoadouts();

    expect(cores).toHaveLength(1);
    expect(policies).toHaveLength(1);
    expect(loadouts).toHaveLength(1);

    const receipt = await receiptStore.getReceipt(res.body.data.receipt.id);
    expect(receipt?.layer).toBe("composition");
    expect(receipt?.inverse.removed).toBeTruthy();
  });

  it("undo removes inferred composition entities", async () => {
    const ownershipReceipt = await receiptStore.createReceipt({
      sourceType: "file_import",
      layer: "ownership",
      sourceMeta: { fileName: "fleet.csv" },
      changeset: { updated: [{ id: "kirk" }] },
      inverse: { updated: [{ id: "kirk" }] },
    });

    const app = createApp(
      makeState({
        pool,
        startupComplete: true,
        referenceStore,
        crewStore,
        receiptStore,
      }),
    );

    const createRes = await testRequest(app)
      .post("/api/import/composition/commit")
      .send({
        sourceReceiptId: ownershipReceipt.id,
        bridgeCores: [
          {
            key: "core-enterprise",
            name: "Kirk Trio",
            members: [
              { officerId: "kirk", slot: "captain" },
              { officerId: "spock", slot: "bridge_1" },
              { officerId: "mccoy", slot: "bridge_2" },
            ],
          },
        ],
        belowDeckPolicies: [
          {
            key: "policy-combat",
            name: "Combat BD",
            mode: "stats_then_bda",
            spec: { prefer_modifiers: ["attack", "critical_damage"] },
          },
        ],
        loadouts: [
          {
            name: "Enterprise Combat",
            shipId: "enterprise",
            bridgeCoreKey: "core-enterprise",
            belowDeckPolicyKey: "policy-combat",
            intentKeys: ["combat"],
            tags: ["import-inferred"],
          },
        ],
      });

    const compositionReceiptId = createRes.body.data.receipt.id;

    const undoRes = await testRequest(app)
      .post(`/api/import/receipts/${compositionReceiptId}/undo`)
      .send({});

    expect(undoRes.status).toBe(200);
    expect(undoRes.body.data.undo.success).toBe(true);

    const cores = await crewStore.listBridgeCores();
    const policies = await crewStore.listBelowDeckPolicies();
    const loadouts = await crewStore.listLoadouts();

    expect(cores).toHaveLength(0);
    expect(policies).toHaveLength(0);
    expect(loadouts).toHaveLength(0);
  });

  it("rejects composition commit when source receipt is not ownership layer", async () => {
    const referenceReceipt = await receiptStore.createReceipt({
      sourceType: "auto_seed",
      layer: "reference",
      changeset: { added: [{ id: "kirk" }] },
      inverse: { removed: [{ id: "kirk" }] },
    });

    const app = createApp(
      makeState({
        pool,
        startupComplete: true,
        referenceStore,
        crewStore,
        receiptStore,
      }),
    );

    const res = await testRequest(app)
      .post("/api/import/composition/commit")
      .send({
        sourceReceiptId: referenceReceipt.id,
        bridgeCores: [
          {
            key: "core-enterprise",
            name: "Kirk Trio",
            members: [
              { officerId: "kirk", slot: "captain" },
              { officerId: "spock", slot: "bridge_1" },
              { officerId: "mccoy", slot: "bridge_2" },
            ],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
    expect(res.body.error.message).toContain("ownership-layer receipt");
  });

  it("rejects loadout that references unknown bridge core key", async () => {
    const ownershipReceipt = await receiptStore.createReceipt({
      sourceType: "file_import",
      layer: "ownership",
      changeset: { updated: [{ id: "kirk" }] },
      inverse: { updated: [{ id: "kirk" }] },
    });

    const app = createApp(
      makeState({
        pool,
        startupComplete: true,
        referenceStore,
        crewStore,
        receiptStore,
      }),
    );

    const res = await testRequest(app)
      .post("/api/import/composition/commit")
      .send({
        sourceReceiptId: ownershipReceipt.id,
        loadouts: [
          {
            name: "Enterprise Combat",
            shipId: "enterprise",
            bridgeCoreKey: "missing-core",
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
    expect(res.body.error.message).toContain("Unknown bridgeCoreKey");
  });

  it.each([
    {
      name: "missing sourceReceiptId",
      body: {
        sourceReceiptId: 0,
        bridgeCores: [
          {
            key: "core-enterprise",
            name: "Kirk Trio",
            members: [
              { officerId: "kirk", slot: "captain" },
              { officerId: "spock", slot: "bridge_1" },
              { officerId: "mccoy", slot: "bridge_2" },
            ],
          },
        ],
      },
      message: "sourceReceiptId",
    },
    {
      name: "no accepted suggestions",
      body: {
        sourceReceiptId: 1,
        bridgeCores: [],
        belowDeckPolicies: [],
        loadouts: [],
      },
      message: "At least one accepted suggestion",
    },
    {
      name: "duplicate bridge core keys",
      body: {
        sourceReceiptId: 1,
        bridgeCores: [
          {
            key: "dup",
            name: "Core A",
            members: [
              { officerId: "kirk", slot: "captain" },
              { officerId: "spock", slot: "bridge_1" },
              { officerId: "mccoy", slot: "bridge_2" },
            ],
          },
          {
            key: "dup",
            name: "Core B",
            members: [
              { officerId: "kirk", slot: "captain" },
              { officerId: "spock", slot: "bridge_1" },
              { officerId: "mccoy", slot: "bridge_2" },
            ],
          },
        ],
      },
      message: "Duplicate bridge core key",
    },
    {
      name: "unknown officer reference",
      body: {
        sourceReceiptId: 1,
        bridgeCores: [
          {
            key: "core-enterprise",
            name: "Kirk Trio",
            members: [
              { officerId: "missing-officer", slot: "captain" },
              { officerId: "spock", slot: "bridge_1" },
              { officerId: "mccoy", slot: "bridge_2" },
            ],
          },
        ],
      },
      message: "Unknown reference IDs",
    },
  ])("composition payload validation: $name", async ({ body, message }) => {
    const ownershipReceipt = await receiptStore.createReceipt({
      sourceType: "file_import",
      layer: "ownership",
      changeset: { updated: [{ id: "kirk" }] },
      inverse: { updated: [{ id: "kirk" }] },
    });

    const app = createApp(
      makeState({
        pool,
        startupComplete: true,
        referenceStore,
        crewStore,
        receiptStore,
      }),
    );

    const payload = { ...body, sourceReceiptId: body.sourceReceiptId === 1 ? ownershipReceipt.id : body.sourceReceiptId };
    const res = await testRequest(app)
      .post("/api/import/composition/commit")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
    expect(String(res.body.error.message)).toContain(message);
  });
});
