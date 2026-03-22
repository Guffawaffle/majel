/**
 * tool-mode.test.ts — Targeted tests for per-run tool policy classification,
 * malformed-function fallback, cancel-before-retry, attempt metadata, and
 * multimodal extraction routing.
 *
 * These tests verify the NEW behaviors introduced in the tool-mode first-pass,
 * not just backward compatibility of existing call sites.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyToolMode, classifyToolModeVerbose, countStructuredLines } from "../src/server/services/gemini/tool-mode.js";
import { createGeminiEngine } from "../src/server/services/gemini/index.js";

// ─── Helpers ──────────────────────────────────────────────────

/** Generate N rows of CSV-like officer data. */
function generateOfficerCsv(rows: number): string {
  const header = "Name,Class,Rarity,Level,Rank";
  const lines = [header];
  for (let i = 1; i <= rows; i++) {
    lines.push(`Officer${i},Command,Epic,${10 + i},${Math.min(i, 5)}`);
  }
  return lines.join("\n");
}

/** Pad a message up to the given character count with extra CSV rows. */
function padToLength(message: string, targetLength: number): string {
  while (message.length < targetLength) {
    message += `\nPadRow,Extra,Data,Value,${message.length}`;
  }
  return message;
}

// ═══════════════════════════════════════════════════════════════
// A. Classifier: large structured transform → "none"
// ═══════════════════════════════════════════════════════════════

describe("classifyToolMode — large structured transform", () => {
  it("routes large CSV + 'parse this' to none", () => {
    const csv = generateOfficerCsv(50);
    const message = `Parse this roster into a table:\n\n${csv}`;
    expect(classifyToolMode(message, false)).toBe("none");
  });

  it("routes large CSV + 'extract' to none", () => {
    const csv = generateOfficerCsv(30);
    const message = `Extract the epic officers from this data:\n\n${csv}`;
    expect(classifyToolMode(message, false)).toBe("none");
  });

  it("routes large CSV + 'convert to csv' to none", () => {
    const csv = generateOfficerCsv(20);
    const message = `Convert this to CSV format:\n\n${csv}`;
    expect(classifyToolMode(message, false)).toBe("none");
  });

  it("routes large CSV + 'format this into a table' to none", () => {
    const csv = generateOfficerCsv(15);
    const message = `Format this into a table:\n\n${csv}`;
    expect(classifyToolMode(message, false)).toBe("none");
  });

  it("routes large CSV without keywords to none when payload exceeds threshold", () => {
    const csv = padToLength(generateOfficerCsv(80), 2500);
    expect(classifyToolMode(csv, false)).toBe("none");
  });
});

// ═══════════════════════════════════════════════════════════════
// B. Classifier: normal fleet advisory → "fleet"
// ═══════════════════════════════════════════════════════════════

describe("classifyToolMode — normal fleet advisory", () => {
  it("routes 'What crew should I use on my Enterprise?' to fleet", () => {
    expect(classifyToolMode("What crew should I use on my Enterprise?", false)).toBe("fleet");
  });

  it("routes 'Who should I put on the bridge of my Jellyfish?' to fleet", () => {
    expect(classifyToolMode("Who should I put on the bridge of my Jellyfish?", false)).toBe("fleet");
  });

  it("routes 'Recommend the best mining crew' to fleet", () => {
    expect(classifyToolMode("Recommend the best mining crew", false)).toBe("fleet");
  });

  it("routes 'Compare the Enterprise and the Jellyfish for combat' to fleet", () => {
    expect(classifyToolMode("Compare the Enterprise and the Jellyfish for combat", false)).toBe("fleet");
  });

  it("routes 'Tell me about the USS Franklin' to fleet", () => {
    expect(classifyToolMode("Tell me about the USS Franklin", false)).toBe("fleet");
  });

  it("routes short ambiguous messages to fleet (default)", () => {
    expect(classifyToolMode("Hello, how are you?", false)).toBe("fleet");
  });
});

// ═══════════════════════════════════════════════════════════════
// C. Classifier: large structured + fleet-ish wording
//
// Policy decision: large structured payload + fleet keywords → "none"
//
// Current rule 3 (structured && isLargePayload) fires REGARDLESS of
// fleet intent, because giant pasted payloads reliably cause
// MALFORMED_FUNCTION_CALL when tools are enabled. The model can reason
// over pasted data directly. The malformed fallback is a second defense
// but we prefer never to need it.
//
// Small structured datasets with fleet keywords (under LARGE_PAYLOAD_THRESHOLD)
// go to "fleet" because the model can handle them safely and the user
// genuinely wants knowledge-backed answers.
// ═══════════════════════════════════════════════════════════════

describe("classifyToolMode — large structured + fleet keywords", () => {
  it("routes huge roster + 'which should I upgrade?' to none", () => {
    const csv = padToLength(generateOfficerCsv(100), 3000);
    const message = `Which of these officers should I upgrade?\n\n${csv}`;
    expect(classifyToolMode(message, false)).toBe("none");
  });

  it("routes huge roster + 'what crew should I use from this roster?' to none", () => {
    const csv = padToLength(generateOfficerCsv(80), 2500);
    const message = `What crew should I use from this roster?\n\n${csv}`;
    expect(classifyToolMode(message, false)).toBe("none");
  });

  it("routes huge roster + 'recommend the best officers' to none", () => {
    const csv = padToLength(generateOfficerCsv(100), 3000);
    const message = `Recommend the best officers from this list:\n\n${csv}`;
    expect(classifyToolMode(message, false)).toBe("none");
  });

  it("allows small structured data + fleet keywords to stay fleet", () => {
    // 6 rows of CSV, well under 2000 chars — safe for tools
    const csv = generateOfficerCsv(6);
    const message = `Which of these officers should I upgrade?\n\n${csv}`;
    expect(message.length).toBeLessThan(2000);
    expect(classifyToolMode(message, false)).toBe("fleet");
  });
});

// ═══════════════════════════════════════════════════════════════
// G. Classifier: multimodal extraction → "none"
// ═══════════════════════════════════════════════════════════════

describe("classifyToolMode — multimodal extraction", () => {
  it("routes image + 'extract these officers into csv' to none", () => {
    expect(classifyToolMode("extract these officers into csv", true)).toBe("none");
  });

  it("routes image + 'parse this screenshot into a table' to none", () => {
    expect(classifyToolMode("parse this screenshot into a table", true)).toBe("none");
  });

  it("routes image + 'convert this to a spreadsheet' to none", () => {
    expect(classifyToolMode("convert this to a spreadsheet format", true)).toBe("none");
  });

  it("keeps image + fleet question as fleet", () => {
    expect(classifyToolMode("What officer is this?", true)).toBe("fleet");
  });

  it("keeps image + ambiguous question as fleet (default)", () => {
    expect(classifyToolMode("What do you see in this image?", true)).toBe("fleet");
  });
});

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// classifyToolModeVerbose — signal exposure for verbose traces
// ═══════════════════════════════════════════════════════════════

describe("classifyToolModeVerbose", () => {
  it("returns mode plus all classifier signals", () => {
    const result = classifyToolModeVerbose("Recommend the best mining crew", false);
    expect(result.mode).toBe("fleet");
    expect(result.bulkDetected).toBe(false);
    expect(result.hasFleetIntent).toBe(true);
    expect(result.hasStructuredData).toBe(false);
    expect(result.hasTransformIntent).toBe(false);
    expect(result.isLargePayload).toBe(false);
    expect(result.hasImage).toBe(false);
    expect(result.messageLength).toBe("Recommend the best mining crew".length);
  });

  it("matches classifyToolMode result in all cases", () => {
    const messages = [
      "What crew should I use?",
      `parse this:\n${generateOfficerCsv(10)}`,
      "Show me my fleet",
    ];
    for (const msg of messages) {
      const simple = classifyToolMode(msg, false);
      const verbose = classifyToolModeVerbose(msg, false);
      expect(verbose.mode).toBe(simple);
    }
  });

  it("reports structured data signal for CSV input", () => {
    const csv = generateOfficerCsv(10);
    const result = classifyToolModeVerbose(`parse this:\n${csv}`, false);
    expect(result.mode).toBe("none");
    expect(result.hasStructuredData).toBe(true);
    expect(result.hasTransformIntent).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// bulkDetected — ADR-049 §3 bulk-commit gate flag
// ═══════════════════════════════════════════════════════════════

describe("bulkDetected (ADR-049)", () => {
  it("sets bulkDetected for structured data + transform intent", () => {
    const csv = generateOfficerCsv(10);
    const result = classifyToolModeVerbose(`parse this roster:\n${csv}`, false);
    expect(result.bulkDetected).toBe(true);
    expect(result.mode).toBe("none");
  });

  it("sets bulkDetected for large structured data without transform keywords", () => {
    const csv = padToLength(`Here are my officers:\n${generateOfficerCsv(20)}`, 2100);
    const result = classifyToolModeVerbose(csv, false);
    expect(result.bulkDetected).toBe(true);
    expect(result.mode).toBe("none");
  });

  it("does NOT set bulkDetected for normal fleet queries", () => {
    const result = classifyToolModeVerbose("Who should I crew the Botany Bay with?", false);
    expect(result.bulkDetected).toBe(false);
    expect(result.mode).toBe("fleet");
  });

  it("does NOT set bulkDetected for image + transform (multimodal extraction)", () => {
    const result = classifyToolModeVerbose("extract these officers into csv", true);
    expect(result.bulkDetected).toBe(false);
    expect(result.mode).toBe("none");
  });

  it("does NOT set bulkDetected for small structured data without transform", () => {
    const csv = generateOfficerCsv(6);
    const result = classifyToolModeVerbose(`Here are some officers:\n${csv}`, false);
    // Small structured data (<2000 chars) without transform keywords → fleet, not bulk
    expect(result.bulkDetected).toBe(false);
    expect(result.mode).toBe("fleet");
  });
});

// ═══════════════════════════════════════════════════════════════
// countStructuredLines — entity count for HandoffCard
// ═══════════════════════════════════════════════════════════════

describe("countStructuredLines", () => {
  it("counts CSV-like lines", () => {
    const csv = generateOfficerCsv(10);
    // 10 data rows + 1 header = 11 CSV-like lines
    expect(countStructuredLines(csv)).toBe(11);
  });

  it("returns 0 for plain text", () => {
    expect(countStructuredLines("Who should I crew the Enterprise with?")).toBe(0);
  });

  it("ignores lines with fewer than 3 comma-separated fields", () => {
    const msg = "Name,Class\nFoo,Bar\nBaz,Qux";
    expect(countStructuredLines(msg)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// D–F: Engine-level integration tests
//
// These test the Gemini engine's runtime behavior when tool mode
// affects sending, fallback, cancellation, and result metadata.
// ═══════════════════════════════════════════════════════════════

describe("createGeminiEngine — tool mode integration", () => {
  // Track calls to the mock SDK so we can inspect tool mode behavior
  let mockSendMessage: ReturnType<typeof vi.fn>;
  let mockChatsCreate: ReturnType<typeof vi.fn>;

  vi.mock("@google/genai", () => {
    const _mockSendMessage = vi.fn().mockResolvedValue({
      text: "Aye, Admiral.",
      functionCalls: undefined,
    });

    const mockChat = {
      sendMessage: _mockSendMessage,
      getHistory: vi.fn().mockReturnValue([]),
    };

    const _mockChatsCreate = vi.fn().mockReturnValue(mockChat);

    const mockCachesCreate = vi.fn().mockResolvedValue({
      name: "cachedContents/fake-cache-id",
      usageMetadata: { totalTokenCount: 750 },
    });
    const mockCachesDelete = vi.fn().mockResolvedValue(undefined);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: "[Summary of earlier conversation]",
    });

    class MockGoogleGenAI {
      constructor(_opts: { apiKey: string }) {}
      chats = { create: _mockChatsCreate };
      caches = { create: mockCachesCreate, delete: mockCachesDelete };
      models = { generateContent: mockGenerateContent };
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

  beforeEach(async () => {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: "fake" });
    mockSendMessage = ai.chats.create({} as never).sendMessage as ReturnType<typeof vi.fn>;
    mockChatsCreate = ai.chats.create as ReturnType<typeof vi.fn>;
    mockSendMessage.mockReset().mockResolvedValue({
      text: "Aye, Admiral.",
      functionCalls: undefined,
    });
  });

  // ─── D. Malformed function fallback ──────────────────────────

  describe("malformed function call → retry toolless", () => {
    it("retries via toolless path when first attempt returns MALFORMED_FUNCTION_CALL", async () => {
      // First call: empty text + MALFORMED_FUNCTION_CALL finish reason
      mockSendMessage
        .mockResolvedValueOnce({
          text: "",
          functionCalls: undefined,
          candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }],
        })
        // Second call (toolless retry): success
        .mockResolvedValueOnce({
          text: "Here is your parsed roster.",
          functionCalls: undefined,
        });

      const mockToolCtx = { forUser: () => ({ userId: "test", deps: {} }) } as never;
      const engine = createGeminiEngine("fake-key", null, null, null, null, mockToolCtx);
      const result = await engine.chat("Parse this data", "test-session", undefined, undefined, undefined, undefined, "fleet");

      expect(result.text).toBe("Here is your parsed roster.");

      // Verify a toolless Chat was created for the retry: at least one
      // chats.create call has systemInstruction and no tools in its config.
      const createCalls = mockChatsCreate.mock.calls;
      const toollessCreates = createCalls.filter((call: unknown[]) => {
        const args = call[0] as { config?: { systemInstruction?: unknown; tools?: unknown } };
        return args.config?.systemInstruction && !args.config?.tools;
      });
      expect(toollessCreates.length).toBeGreaterThanOrEqual(1);

      // Result should track attempts
      expect(result.attempts).toBeDefined();
      expect(result.attempts!.length).toBe(2);
      expect(result.attempts![0].toolMode).toBe("fleet");
      expect(result.attempts![1].toolMode).toBe("none");
      expect(result.attempts![1].retryReason).toBe("MALFORMED_FUNCTION_CALL");
    });

    it("does not create toolless chat when first attempt succeeds", async () => {
      const mockToolCtx = { forUser: () => ({ userId: "test", deps: {} }) } as never;
      const engine = createGeminiEngine("fake-key", null, null, null, null, mockToolCtx);
      const initialCreateCount = mockChatsCreate.mock.calls.length;

      const result = await engine.chat("Hello", "no-fallback-test", undefined, undefined, undefined, undefined, "fleet");

      expect(result.text).toBe("Aye, Admiral.");
      expect(result.attempts).toBeDefined();
      expect(result.attempts!.length).toBe(1);
      expect(result.attempts![0].toolMode).toBe("fleet");
      expect(result.attempts![0].retryReason).toBeUndefined();

      // Only the initial session chat create, no toolless create
      const newCreates = mockChatsCreate.mock.calls.length - initialCreateCount;
      expect(newCreates).toBe(1);
    });
  });

  // ─── E. Cancel before retry ─────────────────────────────────

  describe("cancel before retry", () => {
    it("skips retry when isCancelled returns true before retry attempt", async () => {
      // First call: empty response (triggers retry attempt)
      mockSendMessage
        .mockResolvedValueOnce({
          text: "",
          functionCalls: undefined,
        })
        // This should NOT be reached
        .mockResolvedValueOnce({
          text: "This should not appear.",
          functionCalls: undefined,
        });

      const engine = createGeminiEngine("fake-key");
      const isCancelled = vi.fn().mockReturnValue(true);
      const result = await engine.chat("Hello", "cancel-test", undefined, undefined, undefined, isCancelled, "fleet");

      // Should return empty — retry was skipped
      expect(result.text).toBe("");

      // sendMessage should have been called only once (the initial attempt)
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it("proceeds with retry when isCancelled returns false", async () => {
      mockSendMessage
        .mockResolvedValueOnce({
          text: "",
          functionCalls: undefined,
        })
        .mockResolvedValueOnce({
          text: "Retry succeeded.",
          functionCalls: undefined,
        });

      const engine = createGeminiEngine("fake-key");
      const isCancelled = vi.fn().mockReturnValue(false);
      const result = await engine.chat("Hello", "no-cancel-test", undefined, undefined, undefined, isCancelled, "fleet");

      expect(result.text).toBe("Retry succeeded.");
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ─── F. Attempt metadata ────────────────────────────────────

  describe("attempt metadata on results", () => {
    it("includes toolMode on result for fleet calls", async () => {
      const mockToolCtx = { forUser: () => ({ userId: "test", deps: {} }) } as never;
      const engine = createGeminiEngine("fake-key", null, null, null, null, mockToolCtx);
      const result = await engine.chat("Recommend a crew", "meta-fleet", undefined, undefined, undefined, undefined, "fleet");

      expect(result.toolMode).toBe("fleet");
    });

    it("includes toolMode on result for toolless calls", async () => {
      const engine = createGeminiEngine("fake-key");
      const result = await engine.chat("Format this data", "meta-none", undefined, undefined, undefined, undefined, "none");

      expect(result.toolMode).toBe("none");
    });

    it("includes attempt array with single attempt on success", async () => {
      const mockToolCtx = { forUser: () => ({ userId: "test", deps: {} }) } as never;
      const engine = createGeminiEngine("fake-key", null, null, null, null, mockToolCtx);
      const result = await engine.chat("Hello", "meta-single", undefined, undefined, undefined, undefined, "fleet");

      expect(result.attempts).toBeDefined();
      expect(result.attempts!.length).toBe(1);
      expect(result.attempts![0].attempt).toBe(1);
      expect(result.attempts![0].toolMode).toBe("fleet");
      expect(result.attempts![0].retryReason).toBeUndefined();
    });

    it("includes attempt array with retry info on empty-response retry", async () => {
      mockSendMessage
        .mockResolvedValueOnce({ text: "", functionCalls: undefined })
        .mockResolvedValueOnce({ text: "Recovered.", functionCalls: undefined });

      const engine = createGeminiEngine("fake-key");
      const result = await engine.chat("Hello", "meta-retry", undefined, undefined, undefined, undefined, "fleet");

      expect(result.attempts).toBeDefined();
      expect(result.attempts!.length).toBe(2);
      expect(result.attempts![0].attempt).toBe(1);
      expect(result.attempts![1].attempt).toBe(2);
      expect(result.attempts![1].retryReason).toBe("empty_response");
    });

    it("includes finishReason in attempt when available", async () => {
      mockSendMessage.mockResolvedValueOnce({
        text: "Response.",
        functionCalls: undefined,
        candidates: [{ finishReason: "STOP" }],
      });

      const engine = createGeminiEngine("fake-key");
      const result = await engine.chat("Hello", "meta-finish", undefined, undefined, undefined, undefined, "fleet");

      expect(result.attempts![0].finishReason).toBe("STOP");
    });
  });

  // ─── Session continuity after toolless call ─────────────────

  describe("session rebuild after toolless call", () => {
    it("preserves session continuity after toolless → fleet follow-up", async () => {
      const engine = createGeminiEngine("fake-key");

      // First call: toolless
      await engine.chat("Format this data into a table", "continuity-test", undefined, undefined, undefined, undefined, "none");

      // Second call: fleet mode (follow-up in same session)
      const result = await engine.chat("Now recommend upgrades", "continuity-test", undefined, undefined, undefined, undefined, "fleet");

      expect(result.text).toBe("Aye, Admiral.");

      // History should contain both turns
      const history = engine.getHistory("continuity-test");
      expect(history.length).toBe(4); // 2 turns × 2 (user + model)
      expect(history[0].text).toBe("Format this data into a table");
      expect(history[2].text).toBe("Now recommend upgrades");
    });
  });

  // ─── G. Bulk-commit gate (ADR-049 §3) ────────────────────────

  describe("bulk-commit gate", () => {
    it("strips mutation tools and returns handoff card when bulkDetected", async () => {
      const mockToolCtx = { forUser: () => ({ userId: "test", deps: {} }) } as never;
      const engine = createGeminiEngine("fake-key", null, null, null, null, mockToolCtx);

      const csv = generateOfficerCsv(10);
      const result = await engine.chat(`parse this:\n${csv}`, "bulk-test", undefined, undefined, undefined, undefined, "none", true);

      // Should return handoff card
      expect(result.handoff).toBeDefined();
      expect(result.handoff!.type).toBe("sync_handoff");
      expect(result.handoff!.target).toBe("start_sync");
      expect(result.handoff!.route).toBe("/start/import");
      expect(result.handoff!.detectedEntityCount).toBeGreaterThan(0);
      expect(result.handoff!.summary).toContain("structured data rows");

      // Verify bulk-gated Chat was created with filtered tools (no mutation tools)
      const createCalls = mockChatsCreate.mock.calls;
      const bulkCreates = createCalls.filter((call: unknown[]) => {
        const args = call[0] as { config?: { systemInstruction?: string; tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }> } };
        return args.config?.systemInstruction?.includes("Mutation tools are not available");
      });
      expect(bulkCreates.length).toBeGreaterThanOrEqual(1);

      // Mutation tools should NOT be in the filtered tool declarations
      const bulkConfig = (bulkCreates[0][0] as { config: { tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }> } }).config;
      const toolNames = bulkConfig.tools?.[0]?.functionDeclarations?.map((d: { name?: string }) => d.name) ?? [];
      for (const name of toolNames) {
        expect(name).not.toMatch(/^(create|update|set|sync|assign|remove|complete|activate|delete)_/);
      }
      // Read-only tools should still be present
      expect(toolNames.length).toBeGreaterThan(0);
    });

    it("does not return handoff card for non-bulk requests", async () => {
      const mockToolCtx = { forUser: () => ({ userId: "test", deps: {} }) } as never;
      const engine = createGeminiEngine("fake-key", null, null, null, null, mockToolCtx);

      const result = await engine.chat("Who should I crew the Enterprise with?", "normal-test", undefined, undefined, undefined, undefined, "fleet", false);

      expect(result.handoff).toBeUndefined();
      expect(result.toolMode).toBe("fleet");
    });

    it("omitting bulkDetected safely defaults to no handoff", async () => {
      const mockToolCtx = { forUser: () => ({ userId: "test", deps: {} }) } as never;
      const engine = createGeminiEngine("fake-key", null, null, null, null, mockToolCtx);

      // Call without bulkDetected — 7 explicit args, no 8th
      const result = await engine.chat("Who should I crew the Enterprise with?", "default-test", undefined, undefined, undefined, undefined, "fleet");

      expect(result.handoff).toBeUndefined();
    });

    it("keeps read-only tools when bulk-gated", async () => {
      const mockToolCtx = { forUser: () => ({ userId: "test", deps: {} }) } as never;
      const engine = createGeminiEngine("fake-key", null, null, null, null, mockToolCtx);

      await engine.chat("parse this data", "readonly-test", undefined, undefined, undefined, undefined, "none", true);

      // Verify at least one bulk-gated create was made
      const createCalls = mockChatsCreate.mock.calls;
      const bulkCreates = createCalls.filter((call: unknown[]) => {
        const args = call[0] as { config?: { systemInstruction?: string; tools?: unknown } };
        return args.config?.systemInstruction?.includes("Mutation tools are not available") && args.config?.tools;
      });
      expect(bulkCreates.length).toBeGreaterThanOrEqual(1);
    });
  });
});
