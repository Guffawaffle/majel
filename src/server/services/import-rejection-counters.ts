export type ImportRejectEndpoint = "analyze" | "parse";

export type ImportRejectReason =
  | "file_name_invalid"
  | "missing_content_base64"
  | "base64_too_large"
  | "invalid_base64"
  | "decoded_too_large"
  | "invalid_format"
  | "format_mismatch"
  | "parse_safety_rows"
  | "parse_safety_columns"
  | "parse_safety_cell"
  | "parse_failed_other";

interface ImportRejectCounterRecord {
  endpoint: ImportRejectEndpoint;
  reason: ImportRejectReason;
  count: number;
}

const counters = new Map<string, number>();

export function recordImportReject(endpoint: ImportRejectEndpoint, reason: ImportRejectReason): void {
  const key = `${endpoint}:${reason}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function listImportRejectCounters(): ImportRejectCounterRecord[] {
  return [...counters.entries()]
    .map(([key, count]) => {
      const [endpoint, reason] = key.split(":") as [ImportRejectEndpoint, ImportRejectReason];
      return { endpoint, reason, count };
    })
    .sort((a, b) => (a.endpoint === b.endpoint
      ? a.reason.localeCompare(b.reason)
      : a.endpoint.localeCompare(b.endpoint)));
}

export function resetImportRejectCounters(): void {
  counters.clear();
}

export function classifyImportRejectReason(message: string): ImportRejectReason {
  if (message.includes("must be 1-260 characters")) return "file_name_invalid";
  if (message.includes("contentBase64 is required")) return "missing_content_base64";
  if (message.includes("contentBase64 exceeds size limit")) return "base64_too_large";
  if (message.includes("valid base64")) return "invalid_base64";
  if (message.includes("decoded import payload exceeds size limit")) return "decoded_too_large";
  if (message.includes("format must be one of")) return "invalid_format";
  if (message.includes("does not match declared format")) return "format_mismatch";
  if (message.includes("maximum rows")) return "parse_safety_rows";
  if (message.includes("maximum columns")) return "parse_safety_columns";
  if (message.includes("maximum length")) return "parse_safety_cell";
  return "parse_failed_other";
}