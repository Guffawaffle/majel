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
 * Explicit blocklist of known directive keywords used by the system prompt,
 * matched case-insensitively. This supplements DIRECTIVE_BRACKET (which only
 * catches uppercase) to prevent bypass via lowercase/mixed-case directive
 * forgery (e.g. [reference], [injected data], [intent config]).
 *
 * The list is intentionally narrow to avoid false positives on legitimate
 * game text like [Level 5] or [Alliance Name].
 */
const DIRECTIVE_KEYWORD =
  /\[\s*\/?\s*(?:reference|overlay|injected\s+data|intent\s+config|fleet\s+config|system(?:\s+prompt)?|instruction|context|behavioral\s+rules|progression\s+brief|end\s+\w[\w\s]{0,40})\b[^\]]*\]/gi;

/**
 * Strip prompt-injection markers from a string before it enters model context.
 *
 * This is a display/transport-time sanitization — it does NOT modify stored data.
 * Applied at trust boundaries: tool responses, user message augmentation,
 * and preview string interpolation.
 */
export function sanitizeForModel(text: string): string {
  return text
    .replace(DIRECTIVE_BRACKET, "")
    .replace(DIRECTIVE_KEYWORD, "")
    .replace(DIRECTIVE_XML, "");
}
