# ADR-008: Image Interpretation — Screenshot-to-Data Pipeline

**Status:** Proposed  
**Date:** 2026-02-08  
**Authors:** Guff, Majel (Gemini advisor), Opie (Claude)

## Context

Majel currently operates on text and structured data only. When the Admiral encounters a new officer card, ship stats screen, or event notification in STFC, the only way to get that information into Majel is manual transcription — typing names, stats, and abilities by hand. This is slow, error-prone, and breaks the conversational flow.

Majel proposed a full OCR + object recognition + contextual parsing pipeline. That's the right problem statement but the wrong architecture — because Majel doesn't know she's running on **Gemini 2.5 Flash-Lite, which is natively multimodal**.

### The Shortcut Nobody Told Majel About

Gemini 2.5 supports image understanding out of the box:
- Accepts PNG, JPEG, WEBP, HEIC, HEIF
- Inline base64 data up to 20MB per request
- The `@google/generative-ai` JS SDK's `sendMessage()` accepts `Part[]` — meaning we can pass `[{ inlineData: { data, mimeType } }, "text prompt"]` directly through the existing chat session
- No external OCR library, no computer vision model, no separate pipeline
- The same model that answers questions can also read screenshots

This means image interpretation is **not a new subsystem** — it's an extension of the existing chat interface. The model already understands STFC game UI elements from its training data.

### What Majel Got Right

Despite not knowing her own architecture, Majel's functional requirements are spot-on:

1. **Text extraction from screenshots** — officer names, stats, ability descriptions, ship details
2. **Visual element recognition** — ship classes, officer rarities, faction icons, UI elements
3. **Contextual data structuring** — mapping extracted data to existing fleet entities
4. **Cross-referencing** — "this looks like Kirk" → match to existing officer record

All of these are achievable with Gemini's native vision. No additional dependencies.

### Token Cost Consideration

Image tokens are cheap but not free:
- ≤384px both dimensions: 258 tokens
- Larger images: tiled into 768×768 chunks at 258 tokens each
- A typical phone screenshot (~1080×1920): roughly 6-8 tiles = ~1,500-2,000 tokens
- At $0.075/1M input tokens (Flash-Lite paid tier): a screenshot costs ~$0.00015

Even heavy screenshot usage (50/day) would add ~$0.0075/day. Negligible.

## Decision

### 1. Architecture: Native Gemini Multimodal, Not a Separate Pipeline

**Rejected approach (Majel's proposal):** Dedicated OCR engine → object recognition model → contextual parser → structured output. Three separate systems, external dependencies, integration complexity.

**Chosen approach:** Send image bytes directly to Gemini alongside a text prompt. The model handles OCR, recognition, and structuring in a single inference call.

```
Screenshot → base64 encode → sendMessage([imagePart, textPrompt]) → structured response
```

No new dependencies. No external services. Same model, same session, same system prompt context.

### 2. API Surface

One new endpoint and an extension to the existing chat:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Extended — now accepts optional `image` field (base64 + mimeType) |
| `POST` | `/api/fleet/scan` | Dedicated — extract structured fleet data from screenshot |

#### Extended Chat (`POST /api/chat`)

The existing chat endpoint gains an optional image attachment:

```typescript
// Request body
{
  message: string;                              // Text prompt (required)
  image?: {
    data: string;                               // Base64-encoded image data
    mimeType: "image/png" | "image/jpeg" | "image/webp";
  };
}
```

This lets the Admiral send a screenshot with a question in natural conversation:
- "What officer is this?" + screenshot
- "Is this ship any good for mining?" + screenshot
- "Read this event notification" + screenshot

The model responds conversationally, using both the image and fleet context.

#### Fleet Scan (`POST /api/fleet/scan`)

A dedicated endpoint for structured data extraction. Unlike chat, this returns **parsed, structured data** rather than conversational text:

```typescript
// Request body
{
  image: { data: string; mimeType: string };
  scanType: "officer" | "ship" | "event" | "auto";   // What to look for
}

// Response
{
  ok: true,
  data: {
    scanType: "officer",
    extracted: {
      name: "Khan",
      rarity: "epic",
      level: 35,
      group: "command",
      abilities: [...],
      confidence: 0.92          // Model's self-assessed confidence
    },
    matchedExisting?: {         // If cross-referenced with fleet.db
      officerId: "khan",
      changes: ["level: 30 → 35"]
    },
    rawText?: string            // Full OCR text for debugging
  }
}
```

This feeds directly into the fleet management system (ADR-007). Screenshot an officer card → extract data → upsert into `officers` table.

### 3. Implementation in GeminiEngine

The existing `chat()` method signature extends to accept multimodal content:

```typescript
interface GeminiEngine {
  // Existing
  chat(message: string, sessionId?: string): Promise<string>;

  // Extended — accepts image alongside text
  chat(
    message: string | Array<string | ImagePart>,
    sessionId?: string
  ): Promise<string>;
}

interface ImagePart {
  inlineData: {
    data: string;       // base64
    mimeType: string;   // image/png, image/jpeg, image/webp
  };
}
```

Under the hood, this maps directly to the SDK:

```typescript
// Current (text only)
const result = await chatSession.sendMessage(message);

// Extended (multimodal)
const parts: Part[] = [];
if (image) {
  parts.push({ inlineData: { data: image.data, mimeType: image.mimeType } });
}
parts.push({ text: message });
const result = await chatSession.sendMessage(parts);
```

The `sendMessage` API already accepts `string | Part[]`. This is a minor change.

### 4. Structured Extraction via Prompt Engineering

For the `/api/fleet/scan` endpoint, we need the model to return structured JSON, not conversational text. This uses Gemini's structured output capability:

```typescript
const scanPrompt = `Analyze this STFC screenshot and extract structured data.
Scan type: ${scanType}

Return ONLY valid JSON in this exact format:
{
  "scanType": "${scanType}",
  "extracted": { ... },  // Relevant fields for the scan type
  "confidence": 0.0-1.0, // How confident you are in the extraction
  "rawText": "..."        // All text visible in the image
}

If you cannot confidently extract the requested data, set confidence below 0.5
and explain in a "note" field what went wrong.`;
```

This leverages the epistemic framework (ADR-003) — the model reports confidence honestly rather than fabricating data from unclear screenshots.

### 5. UI Integration

The chat interface gains an image attachment capability:

- **Upload button** next to the send button (camera/paperclip icon)
- **Drag-and-drop** onto the chat area
- **Paste from clipboard** (Ctrl+V with image data) — this is the killer UX for screenshots
- **Preview thumbnail** shown before sending
- **Size limit indicator** — warn if image exceeds 20MB (inline limit)

For the fleet scan:
- **"Scan" button** in the fleet management UI (ADR-007, Phase D)
- Opens camera/file picker
- Shows extraction results with confirm/edit before saving to fleet.db

### 6. Privacy Considerations

Per ADR-001, privacy is a core principle. Image data handling:

- Images are sent to Gemini API as base64 inline data — **same privacy model as text**
- Paid tier = **no training on input data** (same as text prompts)
- Images are NOT stored locally unless the user explicitly saves extraction results
- No third-party OCR services — everything goes through the same Gemini API key
- Assignment log (ADR-007) records "data source: screenshot scan" when fleet data is created from images

## Phasing

### Phase A — Multimodal Chat (v0.5)
- Extend `GeminiEngine.chat()` to accept `Part[]`
- Extend `POST /api/chat` to accept optional `image` field
- UI: paste-from-clipboard support (highest value, lowest effort)
- UI: upload button for image files
- Image preview in chat before sending
- Tests for multimodal message handling

### Phase B — Structured Extraction (v0.6)
- `POST /api/fleet/scan` endpoint
- Scan type prompts for officers, ships, events
- JSON response parsing with confidence scores
- Cross-referencing with existing fleet.db records (depends on ADR-007)
- Extraction result confirmation UI
- Tests for structured extraction accuracy

### Phase C — Smart Import Pipeline (v0.6)
- Batch scanning: multiple screenshots → bulk import
- Diff detection: "you already have this officer at level 30, screenshot shows level 35 — update?"
- Event extraction: read event notifications → create calendar/reminder entries
- Integration with fleet management CRUD (ADR-007)

## Consequences

### Positive
- **Zero new dependencies** — Gemini does everything, no OCR library, no vision model
- **Conversational image analysis** — "tell me about this" is the most natural interface possible
- **Screenshot-to-database pipeline** — combined with ADR-007, screenshots become data entry
- **Same privacy model** — images go through the same API, same paid-tier no-training guarantee
- **Minimal code change** — `sendMessage` already accepts `Part[]`, this is mostly API/UI plumbing
- **Low cost** — ~$0.00015 per screenshot at Flash-Lite rates

### Negative
- **Model accuracy varies** — STFC screenshots have small text, overlapping UI elements, and non-standard fonts. Extraction accuracy will need tuning.
- **No offline capability** — image analysis requires the Gemini API (same constraint as text chat)
- **Token cost scales with images** — a heavy screenshot session with large images could use 10-20x more tokens than text-only. Still cheap, but worth monitoring.
- **Base64 encoding increases payload size** — a 1MB screenshot becomes ~1.33MB in base64. Upload limits apply.

### Risks
- **Extraction reliability for structured data:** The model may misread stats or confuse similar-looking officers. Mitigation: confidence scoring + mandatory user confirmation before saving to fleet.db. The epistemic framework (ADR-003) applies — better to say "I'm 70% sure this is Khan" than confidently misidentify.
- **STFC UI changes:** Game updates may change UI layouts, breaking extraction prompts. Mitigation: scan prompts are configurable, not hardcoded. Community can contribute prompt updates.
- **Image size limits:** 20MB inline limit is generous but very large or very high-res screenshots may need resizing. Mitigation: client-side resize before upload if needed.

## References

- ADR-001 (Architecture — privacy, Gemini paid tier no-training guarantee)
- ADR-003 (Epistemic Framework — confidence signaling, never fabricate)
- ADR-004 (AX-First API — consistent envelope, `/api/fleet/scan` follows the pattern)
- ADR-007 (Fleet Management — screenshot extraction feeds into fleet.db CRUD)
- [Gemini Image Understanding](https://ai.google.dev/gemini-api/docs/image-understanding) — native multimodal API docs
- [Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling) — structured output for extraction
- [`@google/generative-ai` SDK](https://www.npmjs.com/package/@google/generative-ai) — `sendMessage()` accepts `string | Part[]`
