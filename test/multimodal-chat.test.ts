/**
 * multimodal-chat.test.ts — ADR-008 Phase A: Multimodal Chat Tests
 *
 * Tests image attachment support in:
 * - POST /api/chat route (validation, forwarding)
 * - GeminiEngine.chat() (Part[] construction, history recording)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import type { AppState } from "../src/server/app-context.js";
import { createGeminiEngine, type ImagePart } from "../src/server/services/gemini/index.js";

// ─── App setup ──────────────────────────────────────────────

import { makeReadyState, makeConfig } from "./helpers/make-state.js";

const ADMIN_TOKEN = "test-multimodal-token";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return makeReadyState({
    config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
    ...overrides,
  });
}

const bearer = `Bearer ${ADMIN_TOKEN}`;

// Tiny 1x1 transparent PNG in base64
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/pooBPQAAAABJRU5ErkJggg==";

// ─── Route validation tests ─────────────────────────────────

describe("POST /api/chat — image validation (ADR-008)", () => {
  let app: Express;
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockChat = vi.fn().mockResolvedValue("Image received, Admiral.");
    const fakeEngine = {
      chat: mockChat,
      getHistory: () => [],
      getSessionCount: () => 0,
      closeSession: () => {},
      getModel: () => "gemini-2.5-flash-lite",
      setModel: () => {},
      close: () => {},
    };
    app = createApp(makeState({ geminiEngine: fakeEngine }));
  });

  it("accepts a text-only message (backward compatible)", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({ message: "Hello Aria" });

    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("Image received, Admiral.");
    expect(mockChat).toHaveBeenCalledWith("Hello Aria", "default", undefined, expect.any(String));
  });

  it("accepts a message with a valid image attachment", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({
        message: "What officer is this?",
        image: { data: TINY_PNG_BASE64, mimeType: "image/png" },
      });

    expect(res.status).toBe(200);
    expect(mockChat).toHaveBeenCalledWith(
      "What officer is this?",
      "default",
      { inlineData: { data: TINY_PNG_BASE64, mimeType: "image/png" } },
      expect.any(String),
    );
  });

  it("rejects an image with missing data field", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({
        message: "Test",
        image: { mimeType: "image/png" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("data");
  });

  it("rejects an image with missing mimeType field", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({
        message: "Test",
        image: { data: TINY_PNG_BASE64 },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("mimeType");
  });

  it("rejects unsupported image MIME types", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({
        message: "Test",
        image: { data: TINY_PNG_BASE64, mimeType: "image/gif" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Unsupported image type");
    expect(res.body.error.message).toContain("image/gif");
  });

  it("accepts image/jpeg", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({
        message: "Analyze this",
        image: { data: TINY_PNG_BASE64, mimeType: "image/jpeg" },
      });

    expect(res.status).toBe(200);
  });

  it("accepts image/webp", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({
        message: "Analyze this",
        image: { data: TINY_PNG_BASE64, mimeType: "image/webp" },
      });

    expect(res.status).toBe(200);
  });

  it("rejects non-object image field", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({
        message: "Test",
        image: "not-an-object",
      });

    expect(res.status).toBe(400);
  });

  it("rejects non-string image data", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({
        message: "Test",
        image: { data: 12345, mimeType: "image/png" },
      });

    expect(res.status).toBe(400);
  });

  it("still requires message field even with image", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .send({
        image: { data: TINY_PNG_BASE64, mimeType: "image/png" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("message");
  });

  it("passes sessionId from header alongside image", async () => {
    const res = await testRequest(app)
      .post("/api/chat")
      .set("Authorization", bearer)
      .set("X-Session-Id", "img-session-42")
      .send({
        message: "What ship is this?",
        image: { data: TINY_PNG_BASE64, mimeType: "image/png" },
      });

    expect(res.status).toBe(200);
    expect(mockChat).toHaveBeenCalledWith(
      "What ship is this?",
      "img-session-42",
      { inlineData: { data: TINY_PNG_BASE64, mimeType: "image/png" } },
      expect.any(String),
    );
  });
});

// ─── Engine tests ───────────────────────────────────────────

// We must use vi.hoisted() to share a reference between the hoisted vi.mock and test code.
const { mockSendMessage: _mockSendMessage } = vi.hoisted(() => {
  const mockSendMessage = vi.fn().mockResolvedValue({
    text: "Aye, Admiral.",
    functionCalls: undefined,
  });
  return { mockSendMessage };
});

vi.mock("@google/genai", () => {
  const mockChat = {
    sendMessage: _mockSendMessage,
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
    HarmBlockThreshold: { BLOCK_NONE: "BLOCK_NONE" },
    Type: {
      STRING: "STRING", NUMBER: "NUMBER", INTEGER: "INTEGER",
      BOOLEAN: "BOOLEAN", ARRAY: "ARRAY", OBJECT: "OBJECT",
    },
  };
});

describe("GeminiEngine.chat() — multimodal (ADR-008)", () => {
  let engine: ReturnType<typeof createGeminiEngine>;

  beforeEach(() => {
    engine = createGeminiEngine("fake-key");
    _mockSendMessage.mockClear();
  });

  afterEach(() => {
    engine.close();
  });

  it("sends text-only message as string when no image (backward compat)", async () => {
    const response = await engine.chat("Hello");
    expect(response).toEqual({ text: "Aye, Admiral.", proposals: [] });
    expect(_mockSendMessage).toHaveBeenCalledWith({ message: "Hello" });
  });

  it("sends Part[] when image is provided", async () => {
    const image: ImagePart = {
      inlineData: { data: TINY_PNG_BASE64, mimeType: "image/png" },
    };

    const response = await engine.chat("What officer is this?", "default", image);
    expect(response).toEqual({ text: "Aye, Admiral.", proposals: [] });

    // Should send Part[] with image first, then text
    const callArg = _mockSendMessage.mock.calls[0][0];
    expect(callArg.message).toBeInstanceOf(Array);
    expect(callArg.message).toHaveLength(2);
    expect(callArg.message[0]).toHaveProperty("inlineData");
    expect(callArg.message[0].inlineData.mimeType).toBe("image/png");
    expect(callArg.message[1]).toHaveProperty("text", "What officer is this?");
  });

  it("records image presence in history", async () => {
    const image: ImagePart = {
      inlineData: { data: TINY_PNG_BASE64, mimeType: "image/png" },
    };

    await engine.chat("Describe this screenshot", "img-hist", image);

    const history = engine.getHistory("img-hist");
    expect(history).toHaveLength(2);
    // User message should include image marker
    expect(history[0].text).toContain("[image: image/png]");
    expect(history[0].text).toContain("Describe this screenshot");
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("model");
  });

  it("does not include image marker in history for text-only messages", async () => {
    await engine.chat("Plain text question", "no-img");

    const history = engine.getHistory("no-img");
    expect(history[0].text).toBe("Plain text question");
    expect(history[0].text).not.toContain("[image:");
  });
});
