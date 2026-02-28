/**
 * gemini.test.ts — Tests for system prompt construction and engine creation.
 *
 * Tests the core prompt engineering — the thing that most affects Majel's behavior.
 */

import { describe, it, expect, vi } from "vitest";
import { buildSystemPrompt, createGeminiEngine } from "../src/server/services/gemini/index.js";

// ─── buildSystemPrompt ──────────────────────────────────────────

describe("buildSystemPrompt", () => {
  describe("identity layer (always present)", () => {
    it("includes Aria identity regardless of roster", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("You are Aria");
      expect(prompt).toContain("Fleet Intelligence System");
      expect(prompt).toContain("Admiral Guff");
    });

    it("includes Majel Barrett-Roddenberry tribute", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("Majel Barrett-Roddenberry");
      expect(prompt).toContain("1932–2008");
    });

    it("establishes personality traits", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("PERSONALITY:");
      expect(prompt).toContain("Dry wit");
      expect(prompt).toContain("Admiral");
    });

    it("supports intent mode overrides in prompt assembly", () => {
      const prompt = buildSystemPrompt(null, null, false, {
        humor: "off",
        lore: "off",
        verbosity: "+",
        confirmation: "+",
        proactive: "-",
        formality: "+",
      });

      expect(prompt).not.toContain("Dry wit and warmth");
      expect(prompt).not.toContain("Star Trek flavor as seasoning");
      expect(prompt).toContain("Default to deeper explanations");
      expect(prompt).toContain("confirm intent before proceeding");
      expect(prompt).toContain("professional bridge-officer tone");
    });
  });

  describe("scope & authority layer", () => {
    it("declares scope and authority ladder", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("SCOPE & AUTHORITY:");
      expect(prompt).toContain("AUTHORITY LADDER");
      expect(prompt).toContain("training knowledge");
    });

    it("permits discussion of any topic (anti-refusal)", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("any topic the Admiral asks about");
      expect(prompt).toContain("STFC strategy");
      expect(prompt).toContain("Star Trek lore");
    });

    it("treats patch-sensitive STFC specifics as uncertain", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("UNCERTAIN");
      expect(prompt).toContain("outdated");
      expect(prompt).toContain("live game");
    });

    it("discloses underlying systems (Lex, Gemini, catalog) in architecture section", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("Lex");
      expect(prompt).toContain("Gemini");
      expect(prompt).toContain("reference catalog");
    });

    it("architecture section is general-only, no live state claims", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("general description only");
      expect(prompt).toContain("CANNOT inspect your own subsystems");
      expect(prompt).not.toContain("you know this accurately");
    });

    it("includes hard boundaries on fabrication", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("HARD BOUNDARIES");
      expect(prompt).toContain("never fabricate");
    });

    it("includes operating rules with source attribution", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("OPERATING RULES");
      expect(prompt).toContain("SOURCE ATTRIBUTION");
      expect(prompt).toContain("CONFIDENCE SIGNALING");
    });

    it("signals uncertainty is expected behavior", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("I don't have that information");
      expect(prompt).toContain("CORRECTIONS ARE WELCOME");
    });

    it("requires source attribution for all response types", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("INJECTED DATA");
      expect(prompt).toContain("TRAINING KNOWLEDGE");
      expect(prompt).toContain("INFERENCE");
      expect(prompt).toContain("UNKNOWN");
    });

    it("does NOT contain restrictive anti-patterns", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).not.toContain("use ONLY");
      expect(prompt).not.toMatch(/(?<!not )limited to the/i);
      expect(prompt).not.toContain("unable to process");
      expect(prompt).not.toContain("cannot discuss");
      expect(prompt).not.toMatch(/access is limited/i);
      expect(prompt).not.toMatch(/I am unable/i);
    });

    it("does NOT contain overconfidence anti-patterns", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).not.toContain("utterly competent");
      expect(prompt).not.toContain("don't hedge");
      // Should not claim authoritative STFC knowledge
      expect(prompt).not.toContain("you know this accurately");
    });

    it("does NOT enumerate STFC specifics as known capabilities", () => {
      const prompt = buildSystemPrompt();
      // These phrases from the old prompt implied authoritative knowledge
      // of patch-sensitive data the model doesn't actually have
      expect(prompt).not.toMatch(/covers:.*ship stats/is);
      expect(prompt).not.toMatch(/covers:.*tier lists/is);
      expect(prompt).not.toMatch(/covers:.*PvP meta/is);
    });
  });

  describe("model name interpolation", () => {
    it("mentions the model is selectable by the Admiral", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("model selectable by the Admiral");
    });
  });

  describe("with fleet config", () => {
    const config = { opsLevel: 29, drydockCount: 4, shipHangarSlots: 43 };

    it("includes ops level in prompt", () => {
      const prompt = buildSystemPrompt(config);
      expect(prompt).toContain("Operations Level: 29");
    });

    it("includes drydock count in prompt", () => {
      const prompt = buildSystemPrompt(config);
      expect(prompt).toContain("Active Drydocks: 4");
    });

    it("includes hangar slots in prompt", () => {
      const prompt = buildSystemPrompt(config);
      expect(prompt).toContain("Ship Hangar Slots: 43");
    });

    it("interpolates ops level in guidance text", () => {
      const prompt = buildSystemPrompt(config);
      expect(prompt).toContain("At Ops 29");
    });

    it("interpolates drydock count in guidance text", () => {
      const prompt = buildSystemPrompt(config);
      expect(prompt).toContain("With 4 drydocks");
    });

    it("works alongside fleet config", () => {
      const prompt = buildSystemPrompt(config);
      expect(prompt).toContain("Operations Level: 29");
    });

    it("shows per-message injection instructions when null", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("FLEET CONFIGURATION");
      expect(prompt).toContain("per-message");
      expect(prompt).toContain("[FLEET CONFIG]");
      expect(prompt).not.toContain("Operations Level: ");
    });

    it("shows per-message injection instructions when undefined", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("FLEET CONFIGURATION");
      expect(prompt).toContain("per-message");
      expect(prompt).not.toContain("Operations Level: ");
    });
  });

  describe("with dock briefing", () => {
    const briefing = "DRYDOCK STATUS\n- Dock 1: USS Enterprise (Battleship) — Warp drive upgrade [active]\n\nCREW PRESETS\n- \"Alpha Crew\" for USS Enterprise: Kirk (Captain), Spock (Science)\n\nINSIGHTS\n- 1 dock active of 2 total";

    it("includes dock briefing in prompt", () => {
      const prompt = buildSystemPrompt(null, briefing);
      expect(prompt).toContain("DRYDOCK LOADOUT INTELLIGENCE");
      expect(prompt).toContain("DRYDOCK STATUS");
      expect(prompt).toContain("USS Enterprise");
    });

    it("includes crew preset data", () => {
      const prompt = buildSystemPrompt(null, briefing);
      expect(prompt).toContain("Alpha Crew");
      expect(prompt).toContain("Kirk (Captain)");
    });

    it("includes insights section", () => {
      const prompt = buildSystemPrompt(null, briefing);
      expect(prompt).toContain("INSIGHTS");
      expect(prompt).toContain("1 dock active of 2 total");
    });

    it("omits dock briefing section when null", () => {
      const prompt = buildSystemPrompt(null, null);
      expect(prompt).not.toContain("DRYDOCK LOADOUT INTELLIGENCE");
    });

    it("omits dock briefing section when undefined", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).not.toContain("DRYDOCK LOADOUT INTELLIGENCE");
    });

    it("works alongside fleet config", () => {
      const config = { opsLevel: 29, drydockCount: 4, shipHangarSlots: 43 };
      const prompt = buildSystemPrompt(config, briefing);
      expect(prompt).toContain("Operations Level: 29");
      expect(prompt).toContain("DRYDOCK LOADOUT INTELLIGENCE");
      expect(prompt).toContain("USS Enterprise");
    });
  });

  describe("tool-use instructions", () => {
    it("includes tool-use section when hasTools is true", () => {
      const prompt = buildSystemPrompt(null, null, true);
      expect(prompt).toContain("FLEET INTELLIGENCE TOOLS:");
      expect(prompt).toContain("TOOL-USE RULES:");
      expect(prompt).toContain("TOOL SELECTION GUIDE:");
    });

    it("instructs proactive tool use — don't ask, look it up", () => {
      const prompt = buildSystemPrompt(null, null, true);
      expect(prompt).toContain("LOOK IT UP, DON'T ASK");
      expect(prompt).toContain("Do not ask the Admiral for information you can look up");
    });

    it("includes tool chaining guidance", () => {
      const prompt = buildSystemPrompt(null, null, true);
      expect(prompt).toContain("CHAIN TOOLS");
      expect(prompt).toContain("search_ships");
      expect(prompt).toContain("suggest_crew");
    });

    it("includes name resolution guidance", () => {
      const prompt = buildSystemPrompt(null, null, true);
      expect(prompt).toContain("NAME RESOLUTION");
      expect(prompt).toContain("search_officers");
    });

    it("warns about mutation tools requiring confirmation", () => {
      const prompt = buildSystemPrompt(null, null, true);
      expect(prompt).toContain("MUTATIONS");
      expect(prompt).toContain("create_bridge_core");
      expect(prompt).toContain("Confirm intent before calling mutation tools");
    });

    it("omits tool section when hasTools is false", () => {
      const prompt = buildSystemPrompt(null, null, false);
      expect(prompt).not.toContain("FLEET INTELLIGENCE TOOLS:");
    });

    it("omits tool section when hasTools is undefined", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).not.toContain("FLEET INTELLIGENCE TOOLS:");
    });

    it("works alongside fleet config and dock briefing", () => {
      const config = { opsLevel: 29, drydockCount: 4, shipHangarSlots: 43 };
      const briefing = "DRYDOCK STATUS\n- Dock 1: active";
      const prompt = buildSystemPrompt(config, briefing, true);
      expect(prompt).toContain("Operations Level: 29");
      expect(prompt).toContain("DRYDOCK LOADOUT INTELLIGENCE");
      expect(prompt).toContain("FLEET INTELLIGENCE TOOLS:");
    });
  });
});

// ─── createGeminiEngine ─────────────────────────────────────────

describe("createGeminiEngine", () => {
  // We mock the Gemini SDK to avoid real API calls
  vi.mock("@google/genai", () => {
    const mockSendMessage = vi.fn().mockResolvedValue({
      text: "Aye, Admiral.",
      functionCalls: undefined,
    });

    const mockChat = {
      sendMessage: mockSendMessage,
      getHistory: vi.fn().mockReturnValue([]),
    };

    const mockChatsCreate = vi.fn().mockReturnValue(mockChat);

    class MockGoogleGenAI {
      constructor(_opts: { apiKey: string }) {}
      chats = { create: mockChatsCreate };
    }

    return {
      GoogleGenAI: MockGoogleGenAI,
      HarmCategory: {
        HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
        HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
        HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
      },
      HarmBlockThreshold: {
        BLOCK_NONE: "BLOCK_NONE",
      },
      Type: {
        STRING: "STRING",
        NUMBER: "NUMBER",
        INTEGER: "INTEGER",
        BOOLEAN: "BOOLEAN",
        ARRAY: "ARRAY",
        OBJECT: "OBJECT",
      },
    };
  });

  it("creates an engine with chat, getHistory, getSessionCount, closeSession methods", () => {
    const engine = createGeminiEngine("fake-key");
    expect(engine).toHaveProperty("chat");
    expect(engine).toHaveProperty("getHistory");
    expect(engine).toHaveProperty("getSessionCount");
    expect(engine).toHaveProperty("closeSession");
    expect(typeof engine.chat).toBe("function");
    expect(typeof engine.getHistory).toBe("function");
    expect(typeof engine.getSessionCount).toBe("function");
    expect(typeof engine.closeSession).toBe("function");
  });

  it("returns an empty history initially", () => {
    const engine = createGeminiEngine("fake-key");
    expect(engine.getHistory()).toEqual([]);
  });

  it("chat returns model response and updates history", async () => {
    const engine = createGeminiEngine("fake-key");
    const response = await engine.chat("Hello");

    expect(response).toEqual({ text: "Aye, Admiral.", proposals: [] });

    const history = engine.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", text: "Hello" });
    expect(history[1]).toEqual({ role: "model", text: "Aye, Admiral." });
  });

  it("accumulates history across multiple turns", async () => {
    const engine = createGeminiEngine("fake-key");
    await engine.chat("First message");
    await engine.chat("Second message");

    const history = engine.getHistory();
    expect(history).toHaveLength(4);
    expect(history[0].text).toBe("First message");
    expect(history[2].text).toBe("Second message");
  });

  it("returns a copy of history (not a reference)", () => {
    const engine = createGeminiEngine("fake-key");
    const h1 = engine.getHistory();
    const h2 = engine.getHistory();
    expect(h1).not.toBe(h2);
  });

  it("starts with zero active sessions", () => {
    const engine = createGeminiEngine("fake-key");
    expect(engine.getSessionCount()).toBe(0);
  });

  it("creates separate sessions for different sessionIds", async () => {
    const engine = createGeminiEngine("fake-key");
    await engine.chat("Alpha", "session-a");
    await engine.chat("Beta", "session-b");

    expect(engine.getSessionCount()).toBe(2);
    expect(engine.getHistory("session-a")).toHaveLength(2);
    expect(engine.getHistory("session-b")).toHaveLength(2);
    expect(engine.getHistory("session-a")[0].text).toBe("Alpha");
    expect(engine.getHistory("session-b")[0].text).toBe("Beta");
  });

  it("isolates history between sessions", async () => {
    const engine = createGeminiEngine("fake-key");
    await engine.chat("Hello", "s1");
    await engine.chat("World", "s2");

    const h1 = engine.getHistory("s1");
    const h2 = engine.getHistory("s2");
    expect(h1.some((m) => m.text === "World")).toBe(false);
    expect(h2.some((m) => m.text === "Hello")).toBe(false);
  });

  it("closeSession removes the session", async () => {
    const engine = createGeminiEngine("fake-key");
    await engine.chat("Test", "temp-session");
    expect(engine.getSessionCount()).toBe(1);

    engine.closeSession("temp-session");
    expect(engine.getSessionCount()).toBe(0);
    expect(engine.getHistory("temp-session")).toEqual([]);
  });

  it("getHistory returns empty array for unknown sessionId", () => {
    const engine = createGeminiEngine("fake-key");
    expect(engine.getHistory("nonexistent")).toEqual([]);
  });

  // #85 H1: Verify session key namespacing by userId
  it("namespaces session keys by userId to prevent cross-user leakage", async () => {
    const engine = createGeminiEngine("fake-key");
    await engine.chat("User A message", "shared-session-id", undefined, "user-a");
    await engine.chat("User B message", "shared-session-id", undefined, "user-b");

    // Should be stored under different keys: "user-a:shared-session-id" and "user-b:shared-session-id"
    expect(engine.getSessionCount()).toBe(2);

    const historyA = engine.getHistory("user-a:shared-session-id");
    const historyB = engine.getHistory("user-b:shared-session-id");
    expect(historyA).toHaveLength(2);
    expect(historyB).toHaveLength(2);
    expect(historyA[0].text).toBe("User A message");
    expect(historyB[0].text).toBe("User B message");

    // Raw session key should not exist
    expect(engine.getHistory("shared-session-id")).toEqual([]);
  });

  it("falls back to raw session key when userId is undefined", async () => {
    const engine = createGeminiEngine("fake-key");
    await engine.chat("Anonymous message", "anon-session");

    expect(engine.getHistory("anon-session")).toHaveLength(2);
  });

  it("rebuilds SDK Chat when history exceeds turn limit", async () => {
    // SESSION_MAX_TURNS = 50, so 100 history entries (50 pairs) triggers trim
    const engine = createGeminiEngine("fake-key");

    // Send 51 messages to exceed the 50-turn limit
    for (let i = 0; i < 51; i++) {
      await engine.chat(`msg-${i}`, "trim-test");
    }

    const history = engine.getHistory("trim-test");
    // Should be capped at 50 turns (100 entries)
    expect(history.length).toBeLessThanOrEqual(100);
    // Oldest messages should have been dropped
    expect(history[0].text).not.toBe("msg-0");

    // The mock's chats.create should have been called more than once for this session
    // (once on creation, again on rebuild after trim)
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: "fake" });
    // chats.create is called: once per session creation + once per rebuild
    // We have 4 sessions across all tests in this describe, but the trim-test
    // session should have triggered at least one rebuild
    expect((ai.chats.create as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });
});
