/**
 * sanitize.ts — Unified prompt-injection sanitization for LLM trust boundaries.
 *
 * ADR-040 §D1: All untrusted text crossing into model context MUST pass through
 * sanitizeForModel() to strip bracket-delimited directives and XML-like
 * instruction tags that could be used to inject fake system prompts.
 *
 * @see docs/ADR-040-prompt-injection-hardening.md
 */

/**
 * Matches bracket-delimited directive markers used by the system prompt:
 *   [FLEET CONFIG], [END FLEET CONFIG], [INTENT CONFIG], [END INTENT CONFIG],
 *   [CONTEXT FOR THIS QUERY ...], [END CONTEXT], [SYSTEM ...], [INSTRUCTION ...]
 *
 * Also matches XML-style system/instruction tags:
 *   <system>, </system>, <instruction>, </instruction>
 *
 * The pattern is intentionally broad on bracket content — any [UPPER-CASE WORDS]
 * block is stripped, since legitimate user data rarely contains these markers.
 */
const DIRECTIVE_BRACKET = /\[(?:\/?\s*)?[A-Z][A-Z \t/]*(?:\s[^\]]{0,80})?\]/g;
const DIRECTIVE_XML = /<\/?(?:system|instruction|context|config|prompt)[^>]*>/gi;

/**
 * Strip prompt-injection markers from a string before it enters model context.
 *
 * This is a display/transport-time sanitization — it does NOT modify stored data.
 * Applied at trust boundaries: tool responses, user message augmentation,
 * and preview string interpolation.
 */
export function sanitizeForModel(text: string): string {
  return text.replace(DIRECTIVE_BRACKET, "").replace(DIRECTIVE_XML, "");
}
