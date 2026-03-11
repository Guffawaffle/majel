/**
 * claude-engine.test.ts — Unit tests for the Claude Chat Engine.
 *
 * ADR-041 Phase 3: Tests the ClaudeChatEngine factory with a mocked
 * AnthropicVertex client. Validates session management, tool loop,
 * trust gating, and ChatEngine interface compliance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock the Vertex SDK before importing the engine ──────────

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/vertex-sdk", () => {
  return {
    AnthropicVertex: class MockAnthropicVertex {
      messages = { create: mockCreate };
      constructor() { /* no-op */ }
    },
  };
});

// ─── Mock fleet-tools (prevent DB dependencies) ───────────────

vi.mock("../src/server/services/fleet-tools/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/services/fleet-tools/index.js")>();
  return {
    ...original,
    FLEET_TOOL_DECLARATIONS: [
      {
        name: "list_officers",
        description: "List officers",
        parameters: {
          type: "OBJECT",
          properties: {
            limit: { type: "INTEGER", description: "Max results" },
          },
        },
      },
    ],
    executeFleetTool: vi.fn().mockResolvedValue({ officers: ["Kirk", "Spock"] }),
  };
});

vi.mock("../src/server/services/fleet-tools/trust.js", () => ({
  isMutationTool: vi.fn().mockReturnValue(false),
  getTrustLevel: vi.fn().mockResolvedValue("auto"),
}));

import { createClaudeEngine } from "../src/server/services/claude/index.js";
import type { ChatEngine } from "../src/server/services/engine.js";
import { executeFleetTool } from "../src/server/services/fleet-tools/index.js";


// ─── Helpers ──────────────────────────────────────────────────

/** Build a simple Claude text response */
function textResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
    container: null,
  };
}

/** Build a Claude tool_use response */
function toolUseResponse(toolId: string, toolName: string, input: Record<string, unknown>) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "tool_use", id: toolId, name: toolName, input, caller: { type: "direct" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
    container: null,
  };
}

// ─── Test Suite ───────────────────────────────────────────────

describe("ClaudeChatEngine (ADR-041 Phase 3)", () => {
  let engine: ChatEngine;

  const mockToolContextFactory = {
    forUser: vi.fn().mockReturnValue({
      userId: "test-user",
      deps: {
        userSettingsStore: { getTrustOverride: vi.fn() },
      },
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue(textResponse("Aye, Admiral."));
    engine = createClaudeEngine(
      "test-project",
      "us-central1",
      null, // fleetConfig
      null, // dockBriefing
      null, // microRunner
      "claude-sonnet-4-6",
      mockToolContextFactory as any,
      null, // proposalStoreFactory
      null, // userSettingsStore
    );
  });

  afterEach(() => {
    engine.close();
  });

  // ── Constructor validation ──────────────────────────────────

  it("throws if projectId is missing", () => {
    expect(() => createClaudeEngine("", "us-central1")).toThrow("VERTEX_PROJECT_ID");
  });

  it("throws if region is missing", () => {
    expect(() => createClaudeEngine("my-project", "")).toThrow("VERTEX_REGION");
  });

  // ── Basic chat ──────────────────────────────────────────────

  it("sends a message and returns text response", async () => {
    const result = await engine.chat("Hello", "s1", undefined, "user1");
    expect(result.text).toBe("Aye, Admiral.");
    expect(result.proposals).toEqual([]);
    expect(mockCreate).toHaveBeenCalledOnce();

    // Verify the SDK call shape
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.max_tokens).toBe(4096);
    expect(typeof call.system).toBe("string");
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe("user");
    expect(call.messages[0].content).toBe("Hello");
  });

  it("includes tools in the request when toolContextFactory is provided", async () => {
    await engine.chat("list my officers", "s1", undefined, "user1");
    const call = mockCreate.mock.calls[0][0];
    expect(call.tools).toBeDefined();
    expect(call.tools.length).toBeGreaterThan(0);
    expect(call.tools[0].name).toBe("list_officers");
  });

  // ── Session management ──────────────────────────────────────

  it("maintains conversation history across messages", async () => {
    await engine.chat("First message", "s1", undefined, "user1");
    mockCreate.mockResolvedValueOnce(textResponse("Second response."));
    await engine.chat("Second message", "s1", undefined, "user1");

    const history = engine.getHistory("user1:s1");
    expect(history).toHaveLength(4); // 2 turns × 2 entries each
    expect(history[0]).toEqual({ role: "user", text: "First message" });
    expect(history[1]).toEqual({ role: "model", text: "Aye, Admiral." });
    expect(history[2]).toEqual({ role: "user", text: "Second message" });
    expect(history[3]).toEqual({ role: "model", text: "Second response." });
  });

  it("isolates sessions by userId", async () => {
    await engine.chat("User A message", "s1", undefined, "userA");
    mockCreate.mockResolvedValueOnce(textResponse("User B response."));
    await engine.chat("User B message", "s1", undefined, "userB");

    expect(engine.getHistory("userA:s1")).toHaveLength(2);
    expect(engine.getHistory("userB:s1")).toHaveLength(2);
    expect(engine.getSessionCount()).toBe(2);
  });

  it("returns empty history for unknown session", () => {
    expect(engine.getHistory("nonexistent")).toEqual([]);
  });

  it("closes a specific session", async () => {
    await engine.chat("Hello", "s1", undefined, "user1");
    expect(engine.getSessionCount()).toBe(1);

    engine.closeSession("user1:s1");
    expect(engine.getSessionCount()).toBe(0);
    expect(engine.getHistory("user1:s1")).toEqual([]);
  });

  // ── Model management ───────────────────────────────────────

  it("returns the current model", () => {
    expect(engine.getModel()).toBe("claude-sonnet-4-6");
  });

  it("switches model and clears sessions", async () => {
    await engine.chat("Hello", "s1", undefined, "user1");
    expect(engine.getSessionCount()).toBe(1);

    engine.setModel("claude-haiku-4-5");
    expect(engine.getModel()).toBe("claude-haiku-4-5");
    expect(engine.getSessionCount()).toBe(0);
  });

  it("throws on unknown model", () => {
    expect(() => engine.setModel("nonexistent-model")).toThrow("Unknown model");
  });

  it("no-ops when setting the same model", async () => {
    await engine.chat("Hello", "s1", undefined, "user1");
    engine.setModel("claude-sonnet-4-6");
    // Sessions should NOT be cleared
    expect(engine.getSessionCount()).toBe(1);
  });

  // ── Tool loop ──────────────────────────────────────────────

  it("handles a single tool call round", async () => {
    // First call: model wants to use a tool
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("tool_1", "list_officers", { limit: 5 }),
    );
    // Second call: model produces final text after receiving tool result
    mockCreate.mockResolvedValueOnce(textResponse("Here are your officers: Kirk, Spock"));

    const result = await engine.chat("list my officers", "s1", undefined, "user1");
    expect(result.text).toBe("Here are your officers: Kirk, Spock");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(executeFleetTool).toHaveBeenCalledWith("list_officers", { limit: 5 }, expect.any(Object));

    // Verify the second call includes tool results
    const secondCall = mockCreate.mock.calls[1][0];
    const lastMsg = secondCall.messages[secondCall.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content[0].type).toBe("tool_result");
    expect(lastMsg.content[0].tool_use_id).toBe("tool_1");
  });

  // ── Multimodal ─────────────────────────────────────────────

  it("includes image data in the request", async () => {
    const image = {
      inlineData: {
        data: "base64data",
        mimeType: "image/png",
      },
    };

    await engine.chat("What is this?", "s1", image, "user1");
    const call = mockCreate.mock.calls[0][0];
    const userMsg = call.messages[0];
    expect(userMsg.role).toBe("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0].type).toBe("image");
    expect(userMsg.content[0].source.type).toBe("base64");
    expect(userMsg.content[1].type).toBe("text");
    expect(userMsg.content[1].text).toBe("What is this?");
  });

  // ── Engine lifecycle ───────────────────────────────────────

  it("close() clears all sessions", async () => {
    await engine.chat("msg1", "s1", undefined, "user1");
    await engine.chat("msg2", "s2", undefined, "user2");
    expect(engine.getSessionCount()).toBe(2);

    engine.close();
    expect(engine.getSessionCount()).toBe(0);
  });

  // ── Claude message history sent to API ─────────────────────

  it("sends prior conversation to Claude for multi-turn", async () => {
    mockCreate.mockResolvedValueOnce(textResponse("First reply."));
    await engine.chat("First msg", "s1", undefined, "user1");

    mockCreate.mockResolvedValueOnce(textResponse("Second reply."));
    await engine.chat("Second msg", "s1", undefined, "user1");

    // The second call should include the full conversation
    const secondCall = mockCreate.mock.calls[1][0];
    expect(secondCall.messages.length).toBeGreaterThanOrEqual(3);
    // user, assistant, user (at minimum)
    expect(secondCall.messages[0].role).toBe("user");
    expect(secondCall.messages[1].role).toBe("assistant");
    expect(secondCall.messages[2].role).toBe("user");
  });
});
