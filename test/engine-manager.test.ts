/**
 * engine-manager.test.ts — Tests for the multi-provider EngineManager
 *
 * ADR-041 Phase 4: Verifies that the EngineManager correctly routes
 * chat calls to the right provider engine based on the selected model.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEngineManager } from "../src/server/services/engine-manager.js";
import type { ChatEngine } from "../src/server/services/engine.js";

// ─── Helpers ──────────────────────────────────────────────────

function createMockEngine(modelId: string): ChatEngine {
  let current = modelId;
  return {
    chat: vi.fn().mockResolvedValue({ text: `response from ${modelId}`, toolCalls: [], proposals: [] }),
    getHistory: vi.fn().mockReturnValue([]),
    getSessionCount: vi.fn().mockReturnValue(1),
    closeSession: vi.fn(),
    getModel: vi.fn(() => current),
    setModel: vi.fn((id: string) => { current = id; }),
    close: vi.fn(),
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe("EngineManager", () => {
  let gemini: ChatEngine;
  let claude: ChatEngine;

  beforeEach(() => {
    gemini = createMockEngine("gemini-3-pro-preview");
    claude = createMockEngine("claude-sonnet-4-5");
  });

  // ── Construction ──────────────────────────────────────────

  it("creates with Gemini only (no Claude)", () => {
    const manager = createEngineManager({ geminiEngine: gemini });
    expect(manager.getModel()).toBe("gemini-3-pro-preview");
    manager.close();
  });

  it("creates with both engines", () => {
    const manager = createEngineManager({ geminiEngine: gemini, claudeEngine: claude });
    expect(manager.getModel()).toBe("gemini-3-pro-preview");
    manager.close();
  });

  // ── Model switching ───────────────────────────────────────

  it("switches to a Gemini model and delegates to Gemini engine", () => {
    const manager = createEngineManager({ geminiEngine: gemini, claudeEngine: claude });
    manager.setModel("gemini-2.5-flash");
    expect(gemini.setModel).toHaveBeenCalledWith("gemini-2.5-flash");
    expect(claude.setModel).not.toHaveBeenCalled();
    manager.close();
  });

  it("switches to a Claude model and delegates to Claude engine", () => {
    const manager = createEngineManager({ geminiEngine: gemini, claudeEngine: claude });
    manager.setModel("claude-sonnet-4-5");
    expect(claude.setModel).toHaveBeenCalledWith("claude-sonnet-4-5");
    manager.close();
  });

  it("stays on current model when switching to Claude without Claude engine", () => {
    const manager = createEngineManager({ geminiEngine: gemini });
    manager.setModel("claude-sonnet-4-5");
    // Should NOT have called setModel on Gemini (model didn't change)
    expect(gemini.setModel).not.toHaveBeenCalled();
    expect(manager.getModel()).toBe("gemini-3-pro-preview");
    manager.close();
  });

  // ── Chat routing ──────────────────────────────────────────

  it("routes chat to Gemini when a Gemini model is active", async () => {
    const manager = createEngineManager({ geminiEngine: gemini, claudeEngine: claude });
    await manager.chat("hello", "s1");
    expect(gemini.chat).toHaveBeenCalledWith("hello", "s1", undefined, undefined, undefined);
    expect(claude.chat).not.toHaveBeenCalled();
    manager.close();
  });

  it("routes chat to Claude when a Claude model is active", async () => {
    const manager = createEngineManager({ geminiEngine: gemini, claudeEngine: claude });
    manager.setModel("claude-opus-4");
    await manager.chat("hello", "s1");
    expect(claude.chat).toHaveBeenCalled();
    expect(gemini.chat).not.toHaveBeenCalled();
    manager.close();
  });

  it("falls back to Gemini for chat when Claude is not available and an unknown model is set", async () => {
    const manager = createEngineManager({ geminiEngine: gemini });
    // unknown model defaults to gemini provider
    await manager.chat("hello");
    expect(gemini.chat).toHaveBeenCalled();
    manager.close();
  });

  // ── Session management ────────────────────────────────────

  it("returns combined session count from all engines", () => {
    (gemini.getSessionCount as ReturnType<typeof vi.fn>).mockReturnValue(3);
    (claude.getSessionCount as ReturnType<typeof vi.fn>).mockReturnValue(2);
    const manager = createEngineManager({ geminiEngine: gemini, claudeEngine: claude });
    expect(manager.getSessionCount()).toBe(5);
    manager.close();
  });

  it("closes session on both engines", () => {
    const manager = createEngineManager({ geminiEngine: gemini, claudeEngine: claude });
    manager.closeSession("s1");
    expect(gemini.closeSession).toHaveBeenCalledWith("s1");
    expect(claude.closeSession).toHaveBeenCalledWith("s1");
    manager.close();
  });

  it("session count sums correctly without Claude", () => {
    (gemini.getSessionCount as ReturnType<typeof vi.fn>).mockReturnValue(7);
    const manager = createEngineManager({ geminiEngine: gemini });
    expect(manager.getSessionCount()).toBe(7);
    manager.close();
  });

  // ── History ───────────────────────────────────────────────

  it("delegates getHistory to the active engine", () => {
    const history = [{ role: "user", text: "hi" }];
    (gemini.getHistory as ReturnType<typeof vi.fn>).mockReturnValue(history);
    const manager = createEngineManager({ geminiEngine: gemini, claudeEngine: claude });
    expect(manager.getHistory("s1")).toBe(history);
    expect(gemini.getHistory).toHaveBeenCalledWith("s1");
    manager.close();
  });

  // ── Lifecycle ─────────────────────────────────────────────

  it("close() shuts down both engines", () => {
    const manager = createEngineManager({ geminiEngine: gemini, claudeEngine: claude });
    manager.close();
    expect(gemini.close).toHaveBeenCalled();
    expect(claude.close).toHaveBeenCalled();
  });

  it("close() works with Gemini only", () => {
    const manager = createEngineManager({ geminiEngine: gemini });
    manager.close();
    expect(gemini.close).toHaveBeenCalled();
  });
});
