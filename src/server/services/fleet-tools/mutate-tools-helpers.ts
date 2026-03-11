/**
 * fleet-tools/mutate-tools-helpers.ts — Shared validation helpers for mutation tools
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Extracted from mutate-tools.ts (#193) so domain modules share
 * common input validation without duplicating code.
 */

/** Max length for user-provided name fields. */
export const MAX_NAME_LEN = 120;

/** Max length for user-provided notes fields. */
export const MAX_NOTES_LEN = 500;

/** Safely extract and trim a string arg; returns "" if absent. */
export function str(args: Record<string, unknown>, key: string): string {
  return String(args[key] ?? "").trim();
}

/** Validate and truncate a name field. Returns the cleaned name or an error object. */
export function validName(raw: string, label: string): string | { error: string } {
  if (!raw) return { error: `${label} is required.` };
  if (raw.length > MAX_NAME_LEN)
    return { error: `${label} must be ${MAX_NAME_LEN} characters or fewer (got ${raw.length}).` };
  return raw;
}

/** Validate and truncate optional notes. */
export function validNotes(args: Record<string, unknown>): string | undefined {
  const raw = str(args, "notes");
  if (!raw) return undefined;
  return raw.slice(0, MAX_NOTES_LEN);
}
