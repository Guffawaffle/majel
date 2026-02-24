import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/index.js";
import { createInviteStore, type InviteStore } from "../src/server/stores/invite-store.js";
import { TENANT_COOKIE } from "../src/server/services/auth.js";
import { makeConfig, makeState } from "./helpers/make-state.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { expectRouteErrorCase, type RouteErrorCase } from "./helpers/route-cases.js";

const ADMIN_TOKEN = "test-admiral-token-12345";

let pool: Pool;
let inviteStore: InviteStore;
let visitorCookie = "";

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await cleanDatabase(pool);
  inviteStore = await createInviteStore(pool);
  const code = await inviteStore.createCode();
  const session = await inviteStore.redeemCode(code.code);
  visitorCookie = `${TENANT_COOKIE}=${session.tenantId}`;
});

function authEnabledState() {
  return makeState({
    startupComplete: true,
    config: makeConfig({ authEnabled: true, adminToken: ADMIN_TOKEN }),
    inviteStore,
  });
}

function unauthenticatedCases(): RouteErrorCase[] {
  return [
    {
      name: "GET /api/import/receipts unauthenticated",
      method: "get",
      path: "/api/import/receipts",
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED",
    },
    {
      name: "POST /api/import/parse unauthenticated",
      method: "post",
      path: "/api/import/parse",
      body: {
        fileName: "fleet.csv",
        contentBase64: Buffer.from("Officer\nKirk", "utf8").toString("base64"),
        format: "csv",
      },
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED",
    },
    {
      name: "GET /api/mutations/proposals unauthenticated",
      method: "get",
      path: "/api/mutations/proposals",
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED",
    },
    {
      name: "GET /api/catalog/officers unauthenticated",
      method: "get",
      path: "/api/catalog/officers",
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED",
    },
    {
      name: "GET /api/targets unauthenticated",
      method: "get",
      path: "/api/targets",
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED",
    },
    {
      name: "GET /api/bridge-cores unauthenticated",
      method: "get",
      path: "/api/bridge-cores",
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED",
    },
  ];
}

function insufficientRankCases(cookie: string): RouteErrorCase[] {
  return [
    {
      name: "POST /api/import/receipts/:id/undo as visitor",
      method: "post",
      path: "/api/import/receipts/1/undo",
      headers: { Cookie: cookie },
      expectedStatus: 403,
      expectedCode: "INSUFFICIENT_RANK",
      expectedMessageFragment: "Minimum rank required: admiral",
    },
    {
      name: "POST /api/import/receipts/:id/resolve as visitor",
      method: "post",
      path: "/api/import/receipts/1/resolve",
      body: { resolvedItems: [] },
      headers: { Cookie: cookie },
      expectedStatus: 403,
      expectedCode: "INSUFFICIENT_RANK",
      expectedMessageFragment: "Minimum rank required: admiral",
    },
    {
      name: "POST /api/targets as visitor",
      method: "post",
      path: "/api/targets",
      headers: { Cookie: cookie },
      body: { targetType: "officer", refId: "kirk" },
      expectedStatus: 403,
      expectedCode: "INSUFFICIENT_RANK",
      expectedMessageFragment: "Minimum rank required: admiral",
    },
    {
      name: "POST /api/bridge-cores as visitor",
      method: "post",
      path: "/api/bridge-cores",
      headers: { Cookie: cookie },
      body: { name: "Alpha", members: [{ officerId: "kirk", slot: "captain" }] },
      expectedStatus: 403,
      expectedCode: "INSUFFICIENT_RANK",
      expectedMessageFragment: "Minimum rank required: admiral",
    },
  ];
}

function admiralEnvelopeCases(): RouteErrorCase[] {
  return [
    {
      name: "admiral token reaches receipt undo route",
      method: "post",
      path: "/api/import/receipts/1/undo",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      expectedStatus: 503,
      expectedCode: "RECEIPT_STORE_NOT_AVAILABLE",
    },
    {
      name: "admiral token reaches proposals list route",
      method: "get",
      path: "/api/mutations/proposals",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      expectedStatus: 503,
      expectedCode: "PROPOSAL_STORE_NOT_AVAILABLE",
    },
    {
      name: "admiral token reaches import parse route",
      method: "post",
      path: "/api/import/parse",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: {
        fileName: "fleet.csv",
        contentBase64: Buffer.from("Officer,Level\nKirk,20\n", "utf8").toString("base64"),
        format: "csv",
      },
      expectedStatus: 200,
    },
    {
      name: "admiral token reaches catalog officers route",
      method: "get",
      path: "/api/catalog/officers",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      expectedStatus: 503,
      expectedCode: "REFERENCE_STORE_NOT_AVAILABLE",
    },
    {
      name: "admiral token reaches targets list route",
      method: "get",
      path: "/api/targets",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      expectedStatus: 503,
      expectedCode: "TARGET_STORE_NOT_AVAILABLE",
    },
    {
      name: "admiral token reaches bridge cores route",
      method: "get",
      path: "/api/bridge-cores",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      expectedStatus: 503,
      expectedCode: "CREW_STORE_NOT_AVAILABLE",
    },
  ];
}

function visitorRouteLevelCases(cookie: string): RouteErrorCase[] {
  return [
    {
      name: "visitor reaches catalog route",
      method: "get",
      path: "/api/catalog/officers",
      headers: { Cookie: cookie },
      expectedStatus: 503,
      expectedCode: "REFERENCE_STORE_NOT_AVAILABLE",
    },
    {
      name: "visitor reaches targets route",
      method: "get",
      path: "/api/targets",
      headers: { Cookie: cookie },
      expectedStatus: 503,
      expectedCode: "TARGET_STORE_NOT_AVAILABLE",
    },
    {
      name: "visitor reaches crew route",
      method: "get",
      path: "/api/bridge-cores",
      headers: { Cookie: cookie },
      expectedStatus: 503,
      expectedCode: "CREW_STORE_NOT_AVAILABLE",
    },
  ];
}

describe("data routes — auth boundaries", () => {
  it.each<RouteErrorCase>(unauthenticatedCases())("returns 401 for unauthenticated access: $name", async (routeCase) => {
    const app = createApp(authEnabledState());
    await expectRouteErrorCase(app, routeCase);
  });

  it("returns 403 for insufficient rank on admiral-only data routes", async () => {
    const app = createApp(authEnabledState());
    for (const routeCase of insufficientRankCases(visitorCookie)) {
      await expectRouteErrorCase(app, routeCase);
    }
  });

  it.each<RouteErrorCase>(admiralEnvelopeCases())("allows admiral auth and returns route-level envelope: $name", async (routeCase) => {
    const app = createApp(authEnabledState());
    await expectRouteErrorCase(app, routeCase);
  });

  it("allows visitor auth and reaches visitor-level data route envelopes", async () => {
    const app = createApp(authEnabledState());
    for (const routeCase of visitorRouteLevelCases(visitorCookie)) {
      await expectRouteErrorCase(app, routeCase);
    }
  });

  it("includes auth hints in UNAUTHORIZED response envelope", async () => {
    const app = createApp(authEnabledState());
    const res = await expectRouteErrorCase(app, {
      name: "unauthenticated proposals list",
      method: "get",
      path: "/api/mutations/proposals",
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED",
    });
    expect(Array.isArray(res.body.error.hints)).toBe(true);
    expect(res.body.error.hints[0]).toContain("Bearer token");
  });
});
