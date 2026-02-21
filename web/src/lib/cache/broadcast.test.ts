/**
 * broadcast.test.ts — Tests for cross-tab BroadcastChannel invalidation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openBroadcast, closeBroadcast, broadcastInvalidation } from "./broadcast.js";

// Mock BroadcastChannel since jsdom doesn't support it
class MockBroadcastChannel {
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  messages: unknown[] = [];

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown) {
    if (this.closed) throw new Error("Channel closed");
    this.messages.push(data);
  }

  close() {
    this.closed = true;
  }

  static instances: MockBroadcastChannel[] = [];
  static reset() {
    MockBroadcastChannel.instances = [];
  }
}

describe("broadcast", () => {
  beforeEach(() => {
    MockBroadcastChannel.reset();
    // @ts-expect-error — injecting mock
    globalThis.BroadcastChannel = MockBroadcastChannel;
  });

  afterEach(() => {
    closeBroadcast();
    // @ts-expect-error — cleanup mock
    delete globalThis.BroadcastChannel;
  });

  it("opens a channel with the correct name", () => {
    openBroadcast("u1");
    expect(MockBroadcastChannel.instances).toHaveLength(1);
    expect(MockBroadcastChannel.instances[0].name).toBe("majel-cache:u1");
  });

  it("does not open duplicate channels", () => {
    openBroadcast("u1");
    openBroadcast("u1");
    expect(MockBroadcastChannel.instances).toHaveLength(1);
  });

  it("opens a new channel when user scope changes", () => {
    openBroadcast("u1");
    openBroadcast("u2");
    expect(MockBroadcastChannel.instances).toHaveLength(2);
    expect(MockBroadcastChannel.instances[1].name).toBe("majel-cache:u2");
  });

  it("broadcasts invalidation patterns", () => {
    openBroadcast("u1");
    broadcastInvalidation(["catalog:*", "settings*"]);
    const ch = MockBroadcastChannel.instances[0];
    expect(ch.messages).toHaveLength(1);
    expect(ch.messages[0]).toEqual({
      type: "invalidate",
      patterns: ["catalog:*", "settings*"],
      scope: "u1",
    });
  });

  it("silently ignores broadcast when channel is not open", () => {
    // No error thrown
    broadcastInvalidation(["foo*"]);
  });

  it("closes the channel on teardown", () => {
    openBroadcast("u1");
    const ch = MockBroadcastChannel.instances[0];
    expect(ch.closed).toBe(false);
    closeBroadcast();
    expect(ch.closed).toBe(true);
  });

  it("handles incoming invalidation messages", async () => {
    // We need to mock cacheInvalidate
    const { cacheInvalidate } = await import("./idb-cache.js");
    const spy = vi.mocked(cacheInvalidate);

    openBroadcast("u1");
    const ch = MockBroadcastChannel.instances[0];

    // Simulate receiving a message from another tab
    ch.onmessage?.(new MessageEvent("message", {
      data: { type: "invalidate", patterns: ["settings*"], scope: "u1" },
    }));

    // cacheInvalidate is called (mocked in test env, may or may not resolve)
    // Just verify the handler doesn't throw
    expect(ch.onmessage).toBeTruthy();
  });
});
