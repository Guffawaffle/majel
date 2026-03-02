import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import { createApp } from "../src/server/index.js";
import { makeState, makeConfig } from "./helpers/make-state.js";
import { createOperationEventStoreFactory, type OperationEventStoreFactory } from "../src/server/stores/operation-event-store.js";
import { createUserStore, type UserStore } from "../src/server/stores/user-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe("event routes — store not available", () => {
  it("returns 503 when event store is not configured", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api/events/snapshot?topic=chat_run&id=run-1");
    expect(res.status).toBe(503);
  });
});

describe("event routes — replay + snapshot", () => {
  let factory: OperationEventStoreFactory;

  beforeEach(async () => {
    await cleanDatabase(pool);
    factory = await createOperationEventStoreFactory(pool);
  });

  it("returns latest snapshot for the owner", async () => {
    const localStore = factory.forUser("local");
    await localStore.register("chat_run", "run-1", { sessionId: "session-1", tabId: "tab-1" });
    await localStore.emit({ topic: "chat_run", operationId: "run-1", routing: { sessionId: "session-1", tabId: "tab-1" }, eventType: "run.started", status: "running" });
    const latest = await localStore.emit({ topic: "chat_run", operationId: "run-1", routing: { sessionId: "session-1", tabId: "tab-1" }, eventType: "run.progress", status: "running", payloadJson: { pct: 25 } });

    const app = createApp(makeState({ operationEventStoreFactory: factory, operationEventStore: localStore }));
    const res = await testRequest(app).get("/api/events/snapshot?topic=chat_run&id=run-1");

    expect(res.status).toBe(200);
    expect(res.body.data.sessionId).toBe("session-1");
    expect(res.body.data.tabId).toBe("tab-1");
    expect(res.body.data.latest.seq).toBe(latest.seq);
    expect(res.body.data.latest.eventType).toBe("run.progress");
  });

  it("streams replay events after Last-Event-ID", async () => {
    const localStore = factory.forUser("local");
    await localStore.register("chat_run", "run-replay", { sessionId: "session-replay", tabId: "tab-replay" });
    const first = await localStore.emit({ topic: "chat_run", operationId: "run-replay", routing: { sessionId: "session-replay", tabId: "tab-replay" }, eventType: "run.started", status: "running" });
    const second = await localStore.emit({ topic: "chat_run", operationId: "run-replay", routing: { sessionId: "session-replay", tabId: "tab-replay" }, eventType: "run.progress", status: "running", payloadJson: { completedSteps: 1, totalSteps: 3 } });

    const app = createApp(makeState({ operationEventStoreFactory: factory, operationEventStore: localStore }));
    const server = app.listen(0);
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("unable to read test server address");

      const controller = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${addr.port}/api/events/stream?topic=chat_run&id=run-replay`,
        {
          headers: { "Last-Event-ID": String(first.seq) },
          signal: controller.signal,
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const chunk = await reader!.read();
      const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());

      expect(text).toContain(`id: ${second.seq}`);
      expect(text).toContain("event: run.progress");
      expect(text).toContain('"sessionId":"session-replay"');
      expect(text).toContain('"tabId":"tab-replay"');
      controller.abort();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("allows streaming before first event when operation is registered", async () => {
    const localStore = factory.forUser("local");
    await localStore.register("chat_run", "run-empty", { sessionId: "session-empty", tabId: "tab-empty" });

    const app = createApp(makeState({ operationEventStoreFactory: factory, operationEventStore: localStore }));
    const server = app.listen(0);
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("unable to read test server address");

      const controller = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${addr.port}/api/events/stream?topic=chat_run&id=run-empty`,
        { signal: controller.signal },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
      controller.abort();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects topics outside allowlist", async () => {
    const localStore = factory.forUser("local");
    await localStore.register("chat_run", "run-allow", { sessionId: "session-allow", tabId: "tab-allow" });

    const app = createApp(makeState({ operationEventStoreFactory: factory, operationEventStore: localStore }));
    const snapshot = await testRequest(app).get("/api/events/snapshot?topic=unknown_topic&id=run-allow");
    expect(snapshot.status).toBe(400);

    const stream = await testRequest(app).get("/api/events/stream?topic=unknown_topic&id=run-allow");
    expect(stream.status).toBe(400);
  });
});

describe("event routes — auth-enabled isolation", () => {
  const ADMIN_TOKEN = "events-auth-token";
  let userStore: UserStore;
  let factory: OperationEventStoreFactory;
  let userASessionToken: string;
  let userBSessionToken: string;
  let admiralSessionToken: string;
  let userAId: string;

  beforeEach(async () => {
    await cleanDatabase(pool);
    userStore = await createUserStore(pool);
    factory = await createOperationEventStoreFactory(pool);

    const a = await userStore.signUp({
      email: "events-a@test.com",
      password: "securePassword12345!",
      displayName: "Events A",
    });
    const b = await userStore.signUp({
      email: "events-b@test.com",
      password: "securePassword12345!",
      displayName: "Events B",
    });
    const adm = await userStore.signUp({
      email: "events-admiral@test.com",
      password: "securePassword12345!",
      displayName: "Events Admiral",
    });

    await userStore.verifyEmail(a.verifyToken);
    await userStore.verifyEmail(b.verifyToken);
    await userStore.verifyEmail(adm.verifyToken);
    await userStore.setRole(a.user.id, "lieutenant");
    await userStore.setRole(b.user.id, "lieutenant");
    await userStore.setRole(adm.user.id, "admiral");

    userAId = a.user.id;
    userASessionToken = (await userStore.signIn("events-a@test.com", "securePassword12345!")).sessionToken;
    userBSessionToken = (await userStore.signIn("events-b@test.com", "securePassword12345!")).sessionToken;
    admiralSessionToken = (await userStore.signIn("events-admiral@test.com", "securePassword12345!")).sessionToken;

    await factory.forUser(userAId).emit({
      topic: "chat_run",
      operationId: "run-owned-by-a",
      routing: { sessionId: "session-a", tabId: "tab-a" },
      eventType: "run.started",
      status: "running",
    });
  });

  it("denies cross-user snapshot and stream access (including admiral)", async () => {
    const app = createApp(makeState({
      startupComplete: true,
      userStore,
      operationEventStoreFactory: factory,
      operationEventStore: factory.forUser("local"),
      config: makeConfig({ authEnabled: true, adminToken: ADMIN_TOKEN }),
    }));

    const ownerSnapshot = await testRequest(app)
      .get("/api/events/snapshot?topic=chat_run&id=run-owned-by-a")
      .set("Cookie", `majel_session=${userASessionToken}`);
    expect(ownerSnapshot.status).toBe(200);

    const otherSnapshot = await testRequest(app)
      .get("/api/events/snapshot?topic=chat_run&id=run-owned-by-a")
      .set("Cookie", `majel_session=${userBSessionToken}`);
    expect(otherSnapshot.status).toBe(404);

    const admiralSnapshot = await testRequest(app)
      .get("/api/events/snapshot?topic=chat_run&id=run-owned-by-a")
      .set("Cookie", `majel_session=${admiralSessionToken}`);
    expect(admiralSnapshot.status).toBe(404);

    const otherStream = await testRequest(app)
      .get("/api/events/stream?topic=chat_run&id=run-owned-by-a")
      .set("Cookie", `majel_session=${userBSessionToken}`);
    expect(otherStream.status).toBe(404);

    const admiralStream = await testRequest(app)
      .get("/api/events/stream?topic=chat_run&id=run-owned-by-a")
      .set("Cookie", `majel_session=${admiralSessionToken}`);
    expect(admiralStream.status).toBe(404);
  });
});
