/**
 * sessions.test.ts — Chat Session Store Tests
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import {
  createSessionStore,
  generateTimestampTitle,
  type SessionStore,
} from "../src/server/sessions.js";

describe("generateTimestampTitle", () => {
  it("formats date as YYYYMMDD-HHmmss", () => {
    // Use a known local date to avoid UTC/local mismatch
    const d = new Date(2026, 1, 8, 5, 52, 0); // Feb 8, 2026 05:52:00 local
    expect(generateTimestampTitle(d)).toBe("20260208-055200");
  });

  it("pads single-digit values", () => {
    const d = new Date(2026, 0, 3, 2, 5, 7); // Jan 3, 2026 02:05:07 local
    expect(generateTimestampTitle(d)).toBe("20260103-020507");
  });
});

let pool: Pool;

describe("SessionStore", () => {
  let store: SessionStore;

  beforeAll(() => { pool = createTestPool(); });

  beforeEach(async () => {
    await cleanDatabase(pool);
    store = await createSessionStore(pool);
  });

  afterAll(async () => { await pool.end(); });

  it("creates a session with default timestamp title", async () => {
    const session = await store.create("s1");
    expect(session.id).toBe("s1");
    // Title is YYYYMMDD-HHmmss format
    expect(session.title).toMatch(/^\d{8}-\d{6}$/);
    expect(session.createdAt).toBeTruthy();
    expect(session.updatedAt).toBeTruthy();
  });

  it("creates a session with custom title", async () => {
    const session = await store.create("s2", "My Chat");
    expect(session.title).toBe("My Chat");
  });

  it("retrieves a session with messages", async () => {
    await store.create("s1", "Test Session");
    await store.addMessage("s1", "user", "Hello");
    await store.addMessage("s1", "model", "Hi there!");

    const session = await store.get("s1");
    expect(session).not.toBeNull();
    expect(session!.title).toBe("Test Session");
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[0].role).toBe("user");
    expect(session!.messages[0].text).toBe("Hello");
    expect(session!.messages[1].role).toBe("model");
    expect(session!.messages[1].text).toBe("Hi there!");
  });

  it("returns null for nonexistent session", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("auto-creates session on addMessage", async () => {
    await store.addMessage("auto-id", "user", "Hello from nowhere");

    const session = await store.get("auto-id");
    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(1);
    expect(session!.title).toBe("Hello from nowhere");
  });

  it("lists sessions in reverse chronological order", async () => {
    await store.create("s1", "First");
    await store.addMessage("s1", "user", "First user msg");

    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 5));

    await store.create("s2", "Second");
    await store.addMessage("s2", "user", "Second user msg");

    const list = await store.list();
    expect(list.length).toBe(2);
    // Most recently created comes first
    expect(list[0].id).toBe("s2");
    expect(list[1].id).toBe("s1");

    // Check preview (first user message)
    expect(list[0].preview).toBe("Second user msg");
    expect(list[1].preview).toBe("First user msg");

    // Check message count
    expect(list[0].messageCount).toBe(1);
  });

  it("updates session title", async () => {
    await store.create("s1", "Old Title");
    const updated = await store.updateTitle("s1", "New Title");
    expect(updated).toBe(true);

    const session = await store.get("s1");
    expect(session!.title).toBe("New Title");
  });

  it("returns false when updating nonexistent session", async () => {
    expect(await store.updateTitle("nope", "Title")).toBe(false);
  });

  it("deletes a session and its messages", async () => {
    await store.create("s1");
    await store.addMessage("s1", "user", "Hello");
    await store.addMessage("s1", "model", "Hi");

    const deleted = await store.delete("s1");
    expect(deleted).toBe(true);
    expect(await store.get("s1")).toBeNull();
    expect(await store.count()).toBe(0);
  });

  it("returns false when deleting nonexistent session", async () => {
    expect(await store.delete("nope")).toBe(false);
  });

  it("counts sessions", async () => {
    expect(await store.count()).toBe(0);
    await store.create("s1");
    await store.create("s2");
    expect(await store.count()).toBe(2);
  });

  it("limits list results", async () => {
    await store.create("s1");
    await store.create("s2");
    await store.create("s3");

    const limited = await store.list(2);
    expect(limited).toHaveLength(2);
  });

  it("touches session updated_at", async () => {
    await store.create("s1");
    const before = (await store.get("s1"))!.updatedAt;

    // Wait 2ms so ISO timestamp differs
    await new Promise((r) => setTimeout(r, 2));

    await store.touch("s1");
    const after = (await store.get("s1"))!.updatedAt;

    expect(after >= before).toBe(true);
  });
});
