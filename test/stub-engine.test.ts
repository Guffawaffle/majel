/**
 * stub-engine.test.ts — Tests for the deterministic stub ChatEngine (ADR-050)
 */

import { describe, it, expect } from "vitest";
import { createStubEngine } from "../src/server/services/stub-engine.js";

describe("createStubEngine", () => {
  it("returns a ChatEngine with all required methods", () => {
    const engine = createStubEngine();
    expect(typeof engine.chat).toBe("function");
    expect(typeof engine.getHistory).toBe("function");
    expect(typeof engine.getSessionCount).toBe("function");
    expect(typeof engine.closeSession).toBe("function");
    expect(typeof engine.getModel).toBe("function");
    expect(typeof engine.setModel).toBe("function");
    expect(typeof engine.close).toBe("function");
  });

  it("reports stub model ID", () => {
    const engine = createStubEngine();
    expect(engine.getModel()).toBe("stub-echo-v1");
  });

  it("returns deterministic text response", async () => {
    const engine = createStubEngine();
    const result = await engine.chat("Hello fleet");
    expect(result.text).toContain("[stub]");
    expect(result.text).toContain("Hello fleet");
    expect(result.proposals).toEqual([]);
    expect(result.executedTools).toEqual([]);
  });

  it("prefixes fleet mode with tool indicator", async () => {
    const engine = createStubEngine();
    const result = await engine.chat("Check my ships", "session-1", undefined, undefined, undefined, undefined, "fleet");
    expect(result.text).toContain("[stub] Fleet tools available");
    expect(result.toolMode).toBe("fleet");
  });

  it("maintains session history", async () => {
    const engine = createStubEngine();
    await engine.chat("First message", "s1");
    await engine.chat("Second message", "s1");

    const history = engine.getHistory("s1");
    expect(history).toHaveLength(4); // 2 user + 2 model
    expect(history[0].role).toBe("user");
    expect(history[0].text).toBe("First message");
    expect(history[1].role).toBe("model");
    expect(history[2].role).toBe("user");
    expect(history[2].text).toBe("Second message");
  });

  it("tracks session count", async () => {
    const engine = createStubEngine();
    expect(engine.getSessionCount()).toBe(0);

    await engine.chat("msg", "a");
    expect(engine.getSessionCount()).toBe(1);

    await engine.chat("msg", "b");
    expect(engine.getSessionCount()).toBe(2);
  });

  it("closes individual sessions", async () => {
    const engine = createStubEngine();
    await engine.chat("msg", "a");
    await engine.chat("msg", "b");
    expect(engine.getSessionCount()).toBe(2);

    engine.closeSession("a");
    expect(engine.getSessionCount()).toBe(1);
    expect(engine.getHistory("a")).toEqual([]);
  });

  it("clears sessions on model swap", async () => {
    const engine = createStubEngine();
    await engine.chat("msg", "s1");
    expect(engine.getSessionCount()).toBe(1);

    engine.setModel("new-model");
    expect(engine.getModel()).toBe("new-model");
    expect(engine.getSessionCount()).toBe(0);
  });

  it("clears sessions on close", async () => {
    const engine = createStubEngine();
    await engine.chat("msg", "s1");
    engine.close();
    expect(engine.getSessionCount()).toBe(0);
  });

  it("returns attempt metadata", async () => {
    const engine = createStubEngine();
    const result = await engine.chat("test", "s1", undefined, undefined, undefined, undefined, "fleet");
    expect(result.attempts).toEqual([{ attempt: 1, toolMode: "fleet" }]);
  });
});
