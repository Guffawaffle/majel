import { ErrorCode } from "../../envelope.js";
import type { OwnershipState } from "../../stores/overlay-store.js";
import type { ImportFormat } from "../import-mapping.js";
import { recordImportReject } from "../import-rejection-counters.js";

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_IMPORT_BASE64_CHARS = 15_000_000;
const MAX_IMPORT_DECODED_BYTES = 11_500_000;

export interface OfficerOverlayRow {
  refId: string;
  ownershipState: OwnershipState;
  level: number | null;
  rank: string | null;
  power: number | null;
}

export interface ShipOverlayRow {
  refId: string;
  ownershipState: OwnershipState;
  tier: number | null;
  level: number | null;
  power: number | null;
}

export function validateSourcePayload(payload: Record<string, unknown>):
  | { ok: true; input: { fileName: string; contentBase64: string; format: ImportFormat } }
  | { ok: false; code: string; message: string } {
  const { fileName, contentBase64, format } = payload;

  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 260) {
    recordImportReject("parse", "file_name_invalid");
    return { ok: false, code: ErrorCode.INVALID_PARAM, message: "fileName must be 1-260 characters" };
  }
  if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
    recordImportReject("parse", "missing_content_base64");
    return { ok: false, code: ErrorCode.MISSING_PARAM, message: "contentBase64 is required" };
  }
  if (contentBase64.length > MAX_IMPORT_BASE64_CHARS) {
    recordImportReject("parse", "base64_too_large");
    return { ok: false, code: ErrorCode.INVALID_PARAM, message: "contentBase64 exceeds size limit" };
  }
  if (!BASE64_RE.test(contentBase64)) {
    recordImportReject("parse", "invalid_base64");
    return { ok: false, code: ErrorCode.INVALID_PARAM, message: "contentBase64 must be valid base64" };
  }
  const decodedBytes = Math.floor((contentBase64.length * 3) / 4)
    - (contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0);
  if (decodedBytes > MAX_IMPORT_DECODED_BYTES) {
    recordImportReject("parse", "decoded_too_large");
    return { ok: false, code: ErrorCode.INVALID_PARAM, message: "decoded import payload exceeds size limit" };
  }
  if (format !== "csv" && format !== "tsv" && format !== "xlsx") {
    recordImportReject("parse", "invalid_format");
    return { ok: false, code: ErrorCode.INVALID_PARAM, message: 'format must be one of "csv", "tsv", "xlsx"' };
  }

  return {
    ok: true,
    input: {
      fileName,
      contentBase64,
      format,
    },
  };
}

export function toOwnershipState(value: boolean | null | undefined): OwnershipState {
  if (value === true) return "owned";
  if (value === false) return "unowned";
  return "unknown";
}

export function diffFieldsOfficer(before: OfficerOverlayRow | null, next: OfficerOverlayRow): string[] {
  if (!before) {
    const changed: string[] = [];
    if (next.ownershipState !== "unknown") changed.push("ownershipState");
    if (next.level != null) changed.push("level");
    if (next.rank != null) changed.push("rank");
    if (next.power != null) changed.push("power");
    return changed;
  }
  const changed: string[] = [];
  if (before.ownershipState !== next.ownershipState) changed.push("ownershipState");
  if (!sameScalar(before.level, next.level)) changed.push("level");
  if (!sameScalar(before.rank, next.rank)) changed.push("rank");
  if (!sameScalar(before.power, next.power)) changed.push("power");
  return changed;
}

export function diffFieldsShip(before: ShipOverlayRow | null, next: ShipOverlayRow): string[] {
  if (!before) {
    const changed: string[] = [];
    if (next.ownershipState !== "unknown") changed.push("ownershipState");
    if (next.tier != null) changed.push("tier");
    if (next.level != null) changed.push("level");
    if (next.power != null) changed.push("power");
    return changed;
  }
  const changed: string[] = [];
  if (before.ownershipState !== next.ownershipState) changed.push("ownershipState");
  if (!sameScalar(before.tier, next.tier)) changed.push("tier");
  if (!sameScalar(before.level, next.level)) changed.push("level");
  if (!sameScalar(before.power, next.power)) changed.push("power");
  return changed;
}

export function isProtectedOverwriteOfficer(before: OfficerOverlayRow, next: OfficerOverlayRow): boolean {
  if (before.ownershipState !== "unknown" && before.ownershipState !== next.ownershipState) return true;
  if (before.level != null && before.level !== next.level) return true;
  if (before.rank != null && before.rank !== next.rank) return true;
  if (before.power != null && before.power !== next.power) return true;
  return false;
}

export function isProtectedOverwriteShip(before: ShipOverlayRow, next: ShipOverlayRow): boolean {
  if (before.ownershipState !== "unknown" && before.ownershipState !== next.ownershipState) return true;
  if (before.tier != null && before.tier !== next.tier) return true;
  if (before.level != null && before.level !== next.level) return true;
  if (before.power != null && before.power !== next.power) return true;
  return false;
}

function sameScalar(a: string | number | null, b: string | number | null): boolean {
  return a === b;
}
