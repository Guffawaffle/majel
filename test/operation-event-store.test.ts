import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { createOperationEventStoreFactory } from "../src/server/stores/operation-event-store.js";

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe("operation-event-store", () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
  });

  it("replays events strictly after Last-Event-ID cursor", async () => {
    const factory = await createOperationEventStoreFactory(pool);
    const store = factory.forUser("user-a");

    const one = await store.emit({
      topic: "chat_run",
      operationId: "run-1",
      routing: { sessionId: "session-1", tabId: "tab-1" },
      eventType: "run.started",
      status: "running",
      payloadJson: { step: 1 },
    });
    const two = await store.emit({
      topic: "chat_run",
      operationId: "run-1",
      routing: { sessionId: "session-1", tabId: "tab-1" },
      eventType: "run.progress",
      status: "running",
      payloadJson: { step: 2 },
    });

    expect(two.seq).toBeGreaterThan(one.seq);

    const replay = await store.listSince("chat_run", "run-1", one.seq);
    expect(replay).toHaveLength(1);
    expect(replay[0].seq).toBe(two.seq);
    expect(replay[0].eventType).toBe("run.progress");
  });

  it("enforces user isolation under RLS", async () => {
    const factory = await createOperationEventStoreFactory(pool);
    const owner = factory.forUser("owner");
    const other = factory.forUser("other");

    await owner.emit({
      topic: "chat_run",
      operationId: "secret-run",
      routing: { sessionId: "session-owner", tabId: "tab-owner" },
      eventType: "run.started",
      status: "running",
    });

    const ownerLatest = await owner.latest("chat_run", "secret-run");
    const otherLatest = await other.latest("chat_run", "secret-run");

    expect(ownerLatest).not.toBeNull();
    expect(otherLatest).toBeNull();
    await expect(other.getRouting("chat_run", "secret-run")).resolves.toBeNull();
  });

  it("stores and returns routing metadata", async () => {
    const factory = await createOperationEventStoreFactory(pool);
    const store = factory.forUser("user-a");

    await store.register("chat_run", "run-routing", { sessionId: "session-42", tabId: "tab-42" });
    const routing = await store.getRouting("chat_run", "run-routing");
    expect(routing).toEqual({ sessionId: "session-42", tabId: "tab-42" });

    const evt = await store.emit({
      topic: "chat_run",
      operationId: "run-routing",
      routing: { sessionId: "session-42", tabId: "tab-42" },
      eventType: "run.progress",
      status: "running",
    });
    expect(evt.sessionId).toBe("session-42");
    expect(evt.tabId).toBe("tab-42");
  });

  it("rejects invalid topics and routing IDs", async () => {
    const factory = await createOperationEventStoreFactory(pool);
    const store = factory.forUser("user-a");

    await expect(
      store.register("BAD_TOPIC", "run-1", { sessionId: "session-1", tabId: "tab-1" }),
    ).rejects.toThrow("Invalid operation topic");

    await expect(
      store.emit({
        topic: "chat_run",
        operationId: "run-1",
        routing: { sessionId: "no spaces allowed", tabId: "tab-1" },
        eventType: "run.started",
      }),
    ).rejects.toThrow("Invalid sessionId");
  });
});
