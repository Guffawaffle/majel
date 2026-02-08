/**
 * sessions.test.ts — Chat Session Store Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createSessionStore,
  generateTimestampTitle,
  type SessionStore,
} from "../src/server/sessions.js";

const TEST_DB = path.resolve(".test-sessions.db");

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

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = createSessionStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates a session with default timestamp title", () => {
    const session = store.create("s1");
    expect(session.id).toBe("s1");
    // Title is YYYYMMDD-HHmmss format
    expect(session.title).toMatch(/^\d{8}-\d{6}$/);
    expect(session.createdAt).toBeTruthy();
    expect(session.updatedAt).toBeTruthy();
  });

  it("creates a session with custom title", () => {
    const session = store.create("s2", "My Chat");
    expect(session.title).toBe("My Chat");
  });

  it("retrieves a session with messages", () => {
    store.create("s1", "Test Session");
    store.addMessage("s1", "user", "Hello");
    store.addMessage("s1", "model", "Hi there!");

    const session = store.get("s1");
    expect(session).not.toBeNull();
    expect(session!.title).toBe("Test Session");
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[0].role).toBe("user");
    expect(session!.messages[0].text).toBe("Hello");
    expect(session!.messages[1].role).toBe("model");
    expect(session!.messages[1].text).toBe("Hi there!");
  });

  it("returns null for nonexistent session", () => {
    expect(store.get("nope")).toBeNull();
  });

  it("auto-creates session on addMessage", () => {
    store.addMessage("auto-id", "user", "Hello from nowhere");

    const session = store.get("auto-id");
    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(1);
    expect(session!.title).toMatch(/^\d{8}-\d{6}$/);
  });

  it("lists sessions in reverse chronological order", async () => {
    store.create("s1", "First");
    store.addMessage("s1", "user", "First user msg");

    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 5));

    store.create("s2", "Second");
    store.addMessage("s2", "user", "Second user msg");

    const list = store.list();
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

  it("updates session title", () => {
    store.create("s1", "Old Title");
    const updated = store.updateTitle("s1", "New Title");
    expect(updated).toBe(true);

    const session = store.get("s1");
    expect(session!.title).toBe("New Title");
  });

  it("returns false when updating nonexistent session", () => {
    expect(store.updateTitle("nope", "Title")).toBe(false);
  });

  it("deletes a session and its messages", () => {
    store.create("s1");
    store.addMessage("s1", "user", "Hello");
    store.addMessage("s1", "model", "Hi");

    const deleted = store.delete("s1");
    expect(deleted).toBe(true);
    expect(store.get("s1")).toBeNull();
    expect(store.count()).toBe(0);
  });

  it("returns false when deleting nonexistent session", () => {
    expect(store.delete("nope")).toBe(false);
  });

  it("counts sessions", () => {
    expect(store.count()).toBe(0);
    store.create("s1");
    store.create("s2");
    expect(store.count()).toBe(2);
  });

  it("limits list results", () => {
    store.create("s1");
    store.create("s2");
    store.create("s3");

    const limited = store.list(2);
    expect(limited).toHaveLength(2);
  });

  it("reports db path", () => {
    expect(store.getDbPath()).toBe(TEST_DB);
  });

  it("touches session updated_at", async () => {
    store.create("s1");
    const before = store.get("s1")!.updatedAt;

    // Wait 2ms so ISO timestamp differs
    await new Promise((r) => setTimeout(r, 2));

    store.touch("s1");
    const after = store.get("s1")!.updatedAt;

    expect(after >= before).toBe(true);
  });
});
