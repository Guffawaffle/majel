import type { Router } from "express";
import type { AppState } from "../app-context.js";
import { createSafeRouter } from "../safe-router.js";
import { sendFail, sendOk, ErrorCode } from "../envelope.js";
import { requireVisitor } from "../services/auth.js";
import { withUserScope } from "../db.js";
import {
  analyzeImport,
  mapParsedRows,
  parseImportData,
  resolveMappedRows,
  type ImportFormat,
  type MappedImportRow,
  type ResolvedImportRow,
  type UnresolvedImportItem,
} from "../services/import-mapping.js";
import type { OwnershipState } from "../stores/overlay-store.js";

const MAX_IMPORT_ROWS = 10000;

interface OfficerOverlayRow {
  refId: string;
  ownershipState: OwnershipState;
  level: number | null;
  rank: string | null;
  power: number | null;
}

interface ShipOverlayRow {
  refId: string;
  ownershipState: OwnershipState;
  tier: number | null;
  level: number | null;
  power: number | null;
}

export function createImportRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const visitor = requireVisitor(appState);

  router.use("/api/import", visitor);

  router.post("/api/import/analyze", async (req, res) => {
    const { fileName, contentBase64, format } = req.body ?? {};

    if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 260) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "fileName must be 1-260 characters", 400);
    }
    if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "contentBase64 is required", 400);
    }
    if (contentBase64.length > 15_000_000) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "contentBase64 exceeds size limit", 400);
    }
    if (format !== "csv" && format !== "xlsx") {
      return sendFail(res, ErrorCode.INVALID_PARAM, 'format must be "csv" or "xlsx"', 400);
    }
    // ADR-032: xlsx disabled until SheetJS vulnerability is resolved (GHSA-4r6h-8v6p-xvw6)
    if (format === "xlsx") {
      return sendFail(res, ErrorCode.INVALID_PARAM, "XLSX import is temporarily disabled for security reasons. Please convert to CSV.", 400);
    }

    try {
      const analysis = await analyzeImport(
        {
          fileName,
          contentBase64,
          format: format as ImportFormat,
        },
        appState.geminiEngine,
      );

      return sendOk(res, { analysis });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendFail(res, ErrorCode.INVALID_PARAM, `Import analysis failed: ${msg}`, 400);
    }
  });

  router.post("/api/import/parse", async (req, res) => {
    const validation = validateSourcePayload(req.body ?? {});
    if (!validation.ok) return sendFail(res, validation.code, validation.message, 400);

    try {
      const parsed = parseImportData(validation.input);
      return sendOk(res, { parsed });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendFail(res, ErrorCode.INVALID_PARAM, `Import parse failed: ${msg}`, 400);
    }
  });

  router.post("/api/import/map", async (req, res) => {
    const { headers, rows, mapping } = req.body ?? {};
    if (!Array.isArray(headers) || !headers.every((header) => typeof header === "string")) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "headers must be a string[]", 400);
    }
    if (!Array.isArray(rows) || !rows.every((row) => Array.isArray(row))) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "rows must be a string[][]", 400);
    }
    if ((rows as unknown[]).length > MAX_IMPORT_ROWS) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `rows must be ${MAX_IMPORT_ROWS} or fewer`, 400);
    }
    if (!mapping || typeof mapping !== "object") {
      return sendFail(res, ErrorCode.INVALID_PARAM, "mapping must be an object", 400);
    }

    const safeRows = (rows as unknown[])
      .map((row) => (row as unknown[]).map((cell) => String(cell ?? "")));
    const mappedRows = mapParsedRows(
      { headers: headers as string[], rows: safeRows },
      mapping as Record<string, string | null | undefined>,
    );

    return sendOk(res, {
      mappedRows,
      summary: {
        rowCount: mappedRows.length,
      },
    });
  });

  router.post("/api/import/resolve", async (req, res) => {
    if (!appState.referenceStore) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }

    const { mappedRows } = req.body ?? {};
    if (!Array.isArray(mappedRows)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "mappedRows must be an array", 400);
    }
    if (mappedRows.length > MAX_IMPORT_ROWS) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `mappedRows must be ${MAX_IMPORT_ROWS} or fewer`, 400);
    }

    const officers = await appState.referenceStore.listOfficers();
    const ships = await appState.referenceStore.listShips();
    const { resolvedRows, unresolved } = resolveMappedRows(
      mappedRows as MappedImportRow[],
      officers.map((officer) => ({ id: officer.id, name: officer.name })),
      ships.map((ship) => ({ id: ship.id, name: ship.name })),
    );

    return sendOk(res, {
      resolvedRows,
      unresolved,
      summary: {
        rows: resolvedRows.length,
        unresolved: unresolved.length,
      },
    });
  });

  router.post("/api/import/commit", async (req, res) => {
    const userId = (res.locals.userId as string) || "local";
    if (!appState.pool) {
      return sendFail(res, ErrorCode.OVERLAY_STORE_NOT_AVAILABLE, "Database pool not available", 503);
    }

    const {
      resolvedRows,
      unresolved,
      mapping,
      sourceMeta,
      fileName,
      allowOverwrite,
    } = req.body ?? {};
    if (!Array.isArray(resolvedRows)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "resolvedRows must be an array", 400);
    }
    if (resolvedRows.length > MAX_IMPORT_ROWS) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `resolvedRows must be ${MAX_IMPORT_ROWS} or fewer`, 400);
    }
    if (!appState.referenceStore) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }

    const unresolvedItems = Array.isArray(unresolved)
      ? (unresolved as UnresolvedImportItem[])
      : [];

    const allowOverwriteFlag = allowOverwrite === true;

    const officerIds = new Set<string>();
    const shipIds = new Set<string>();
    for (const row of resolvedRows as ResolvedImportRow[]) {
      if (row.officerRefId) officerIds.add(row.officerRefId);
      if (row.shipRefId) shipIds.add(row.shipRefId);
    }

    const [officerChecks, shipChecks] = await Promise.all([
      Promise.all([...officerIds].map(async (id) => ({ id, found: !!(await appState.referenceStore!.getOfficer(id)) }))),
      Promise.all([...shipIds].map(async (id) => ({ id, found: !!(await appState.referenceStore!.getShip(id)) }))),
    ]);
    const missingOfficers = officerChecks.filter((item) => !item.found).map((item) => item.id);
    const missingShips = shipChecks.filter((item) => !item.found).map((item) => item.id);
    if (missingOfficers.length > 0 || missingShips.length > 0) {
      return sendFail(
        res,
        ErrorCode.INVALID_PARAM,
        `Unknown reference IDs in commit payload (officers: ${missingOfficers.join(", ") || "none"}; ships: ${missingShips.join(", ") || "none"})`,
        400,
      );
    }

    const outcome = await withUserScope(appState.pool, userId, async (client) => {
      const changesAdded: unknown[] = [];
      const changesUpdated: unknown[] = [];
      const inverseByRef = new Map<string, unknown>();
      const overwriteCandidates: Array<{ entityType: "officer" | "ship"; refId: string; rowIndex: number; changedFields: string[] }> = [];
      const totalEntities = (resolvedRows as ResolvedImportRow[]).reduce((count, row) => {
        let entityCount = count;
        if (row.officerRefId) entityCount += 1;
        if (row.shipRefId) entityCount += 1;
        return entityCount;
      }, 0);

      const plannedOfficerUpserts: Array<{ refId: string; values: OfficerOverlayRow; before: OfficerOverlayRow | null; rowIndex: number; changedFields: string[] }> = [];
      const plannedShipUpserts: Array<{ refId: string; values: ShipOverlayRow; before: ShipOverlayRow | null; rowIndex: number; changedFields: string[] }> = [];

      for (const row of resolvedRows as ResolvedImportRow[]) {
        if (row.officerRefId) {
          const beforeResult = await client.query<OfficerOverlayRow>(
            `SELECT ref_id AS "refId", ownership_state AS "ownershipState", level, rank, power
             FROM officer_overlay WHERE ref_id = $1`,
            [row.officerRefId],
          );
          const before = beforeResult.rows[0] ?? null;
          const nextValues: OfficerOverlayRow = {
            refId: row.officerRefId,
            ownershipState: toOwnershipState(row.officerOwned),
            level: row.officerLevel ?? null,
            rank: row.officerRank ?? null,
            power: row.officerPower ?? null,
          };

          const changedFields = diffFieldsOfficer(before, nextValues);
          if (changedFields.length > 0) {
            plannedOfficerUpserts.push({ refId: row.officerRefId, values: nextValues, before, rowIndex: row.rowIndex, changedFields });
            if (before && isProtectedOverwriteOfficer(before, nextValues)) {
              overwriteCandidates.push({ entityType: "officer", refId: row.officerRefId, rowIndex: row.rowIndex, changedFields });
            }
          }
        }

        if (row.shipRefId) {
          const beforeResult = await client.query<ShipOverlayRow>(
            `SELECT ref_id AS "refId", ownership_state AS "ownershipState", tier, level, power
             FROM ship_overlay WHERE ref_id = $1`,
            [row.shipRefId],
          );
          const before = beforeResult.rows[0] ?? null;
          const nextValues: ShipOverlayRow = {
            refId: row.shipRefId,
            ownershipState: toOwnershipState(row.shipOwned),
            tier: row.shipTier ?? null,
            level: row.shipLevel ?? null,
            power: row.shipPower ?? null,
          };

          const changedFields = diffFieldsShip(before, nextValues);
          if (changedFields.length > 0) {
            plannedShipUpserts.push({ refId: row.shipRefId, values: nextValues, before, rowIndex: row.rowIndex, changedFields });
            if (before && isProtectedOverwriteShip(before, nextValues)) {
              overwriteCandidates.push({ entityType: "ship", refId: row.shipRefId, rowIndex: row.rowIndex, changedFields });
            }
          }
        }
      }

      if (overwriteCandidates.length > 0 && !allowOverwriteFlag) {
        return {
          blocked: true as const,
          overwriteCandidates,
          proposed: {
            added: plannedOfficerUpserts.filter((item) => !item.before).length + plannedShipUpserts.filter((item) => !item.before).length,
            updated: plannedOfficerUpserts.filter((item) => !!item.before).length + plannedShipUpserts.filter((item) => !!item.before).length,
            unchanged: totalEntities - (plannedOfficerUpserts.length + plannedShipUpserts.length),
          },
        };
      }

      for (const plan of plannedOfficerUpserts) {
        await client.query(
          `INSERT INTO officer_overlay (user_id, ref_id, ownership_state, target, level, rank, power, target_note, target_priority, updated_at)
           VALUES ($1, $2, $3, COALESCE((SELECT target FROM officer_overlay WHERE ref_id = $2), FALSE), $4, $5, $6,
                   COALESCE((SELECT target_note FROM officer_overlay WHERE ref_id = $2), NULL),
                   COALESCE((SELECT target_priority FROM officer_overlay WHERE ref_id = $2), NULL), $7)
           ON CONFLICT(user_id, ref_id) DO UPDATE SET
             ownership_state = EXCLUDED.ownership_state,
             level = EXCLUDED.level,
             rank = EXCLUDED.rank,
             power = EXCLUDED.power,
             updated_at = EXCLUDED.updated_at`,
          [
            userId,
            plan.refId,
            plan.values.ownershipState,
            plan.values.level,
            plan.values.rank,
            plan.values.power,
            new Date().toISOString(),
          ],
        );

        const afterResult = await client.query<OfficerOverlayRow>(
          `SELECT ref_id AS "refId", ownership_state AS "ownershipState", level, rank, power
           FROM officer_overlay WHERE ref_id = $1`,
          [plan.refId],
        );
        const after = afterResult.rows[0];
        const payload = {
          entityType: "officer",
          refId: plan.refId,
          rowIndex: plan.rowIndex,
          before: plan.before,
          after,
        };
        if (plan.before) changesUpdated.push(payload);
        else changesAdded.push(payload);
        const key = `officer:${plan.refId}`;
        if (!inverseByRef.has(key)) {
          inverseByRef.set(key, { entityType: "officer", refId: plan.refId, before: plan.before });
        }
      }

      for (const plan of plannedShipUpserts) {
        await client.query(
          `INSERT INTO ship_overlay (user_id, ref_id, ownership_state, target, tier, level, power, target_note, target_priority, updated_at)
           VALUES ($1, $2, $3, COALESCE((SELECT target FROM ship_overlay WHERE ref_id = $2), FALSE), $4, $5, $6,
                   COALESCE((SELECT target_note FROM ship_overlay WHERE ref_id = $2), NULL),
                   COALESCE((SELECT target_priority FROM ship_overlay WHERE ref_id = $2), NULL), $7)
           ON CONFLICT(user_id, ref_id) DO UPDATE SET
             ownership_state = EXCLUDED.ownership_state,
             tier = EXCLUDED.tier,
             level = EXCLUDED.level,
             power = EXCLUDED.power,
             updated_at = EXCLUDED.updated_at`,
          [
            userId,
            plan.refId,
            plan.values.ownershipState,
            plan.values.tier,
            plan.values.level,
            plan.values.power,
            new Date().toISOString(),
          ],
        );

        const afterResult = await client.query<ShipOverlayRow>(
          `SELECT ref_id AS "refId", ownership_state AS "ownershipState", tier, level, power
           FROM ship_overlay WHERE ref_id = $1`,
          [plan.refId],
        );
        const after = afterResult.rows[0];
        const payload = {
          entityType: "ship",
          refId: plan.refId,
          rowIndex: plan.rowIndex,
          before: plan.before,
          after,
        };
        if (plan.before) changesUpdated.push(payload);
        else changesAdded.push(payload);
        const key = `ship:${plan.refId}`;
        if (!inverseByRef.has(key)) {
          inverseByRef.set(key, { entityType: "ship", refId: plan.refId, before: plan.before });
        }
      }

      const unchanged = totalEntities - (plannedOfficerUpserts.length + plannedShipUpserts.length);

      const receiptInsert = await client.query<{ id: number }>(
        `INSERT INTO import_receipts (user_id, source_type, source_meta, mapping, layer, changeset, inverse, unresolved, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          userId,
          "file_import",
          JSON.stringify({
            ...(typeof sourceMeta === "object" && sourceMeta ? sourceMeta : {}),
            fileName: typeof fileName === "string" ? fileName : undefined,
            allowOverwrite: allowOverwriteFlag,
          }),
          typeof mapping === "object" && mapping ? JSON.stringify(mapping as Record<string, unknown>) : null,
          "ownership",
          JSON.stringify({ added: changesAdded, updated: changesUpdated, removed: [] }),
          JSON.stringify({ added: [], updated: [...inverseByRef.values()], removed: [] }),
          unresolvedItems.length > 0 ? JSON.stringify(unresolvedItems) : null,
          new Date().toISOString(),
        ],
      );

      return {
        blocked: false as const,
        receiptId: receiptInsert.rows[0].id,
        summary: {
          added: changesAdded.length,
          updated: changesUpdated.length,
          unchanged,
          unresolved: unresolvedItems.length,
        },
      };
    });

    if (outcome.blocked) {
      return sendFail(
        res,
        ErrorCode.CONFLICT,
        "Import would overwrite existing data. Approval required.",
        409,
        {
          detail: {
            requiresApproval: true,
            overwriteCount: outcome.overwriteCandidates.length,
            overwriteCandidates: outcome.overwriteCandidates,
            proposed: outcome.proposed,
          },
        },
      );
    }

    return sendOk(res, {
      receipt: { id: outcome.receiptId },
      summary: outcome.summary,
      requiresApproval: false,
    });
  });

  return router;
}

function validateSourcePayload(payload: Record<string, unknown>):
  | { ok: true; input: { fileName: string; contentBase64: string; format: ImportFormat } }
  | { ok: false; code: string; message: string } {
  const { fileName, contentBase64, format } = payload;

  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 260) {
    return { ok: false, code: ErrorCode.INVALID_PARAM, message: "fileName must be 1-260 characters" };
  }
  if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
    return { ok: false, code: ErrorCode.MISSING_PARAM, message: "contentBase64 is required" };
  }
  if (contentBase64.length > 15_000_000) {
    return { ok: false, code: ErrorCode.INVALID_PARAM, message: "contentBase64 exceeds size limit" };
  }
  if (format !== "csv" && format !== "xlsx") {
    return { ok: false, code: ErrorCode.INVALID_PARAM, message: 'format must be "csv" or "xlsx"' };
  }
  // ADR-032: xlsx disabled until SheetJS vulnerability is resolved (GHSA-4r6h-8v6p-xvw6)
  if (format === "xlsx") {
    return { ok: false, code: ErrorCode.INVALID_PARAM, message: "XLSX import is temporarily disabled for security reasons. Please convert to CSV." };
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

function toOwnershipState(value: boolean | null | undefined): OwnershipState {
  if (value === true) return "owned";
  if (value === false) return "unowned";
  return "unknown";
}

function diffFieldsOfficer(before: OfficerOverlayRow | null, next: OfficerOverlayRow): string[] {
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

function diffFieldsShip(before: ShipOverlayRow | null, next: ShipOverlayRow): string[] {
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

function isProtectedOverwriteOfficer(before: OfficerOverlayRow, next: OfficerOverlayRow): boolean {
  if (before.ownershipState !== "unknown" && before.ownershipState !== next.ownershipState) return true;
  if (before.level != null && before.level !== next.level) return true;
  if (before.rank != null && before.rank !== next.rank) return true;
  if (before.power != null && before.power !== next.power) return true;
  return false;
}

function isProtectedOverwriteShip(before: ShipOverlayRow, next: ShipOverlayRow): boolean {
  if (before.ownershipState !== "unknown" && before.ownershipState !== next.ownershipState) return true;
  if (before.tier != null && before.tier !== next.tier) return true;
  if (before.level != null && before.level !== next.level) return true;
  if (before.power != null && before.power !== next.power) return true;
  return false;
}

function sameScalar(a: string | number | null, b: string | number | null): boolean {
  return a === b;
}
