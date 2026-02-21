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
import {
  validateSourcePayload,
  toOwnershipState,
  diffFieldsOfficer,
  diffFieldsShip,
  isProtectedOverwriteOfficer,
  isProtectedOverwriteShip,
  type OfficerOverlayRow,
  type ShipOverlayRow,
} from "../services/route-helpers/imports-helpers.js";

const MAX_IMPORT_ROWS = 10000;

interface CompositionBridgeCoreInput {
  key: string;
  name: string;
  notes?: string;
  members: Array<{ officerId: string; slot: "captain" | "bridge_1" | "bridge_2" }>;
}

interface CompositionBelowDeckPolicyInput {
  key: string;
  name: string;
  mode: "stats_then_bda" | "pinned_only" | "stat_fill_only";
  notes?: string;
  spec?: Record<string, unknown>;
}

interface CompositionLoadoutInput {
  name: string;
  shipId: string;
  bridgeCoreKey?: string;
  belowDeckPolicyKey?: string;
  intentKeys?: string[];
  tags?: string[];
  notes?: string;
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
    if (format !== "csv" && format !== "tsv" && format !== "xlsx") {
      return sendFail(res, ErrorCode.INVALID_PARAM, 'format must be one of "csv", "tsv", "xlsx"', 400);
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

  router.post("/api/import/composition/commit", async (req, res) => {
    const userId = (res.locals.userId as string) || "local";
    if (!appState.pool) {
      return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Database pool not available", 503);
    }
    if (!appState.referenceStore) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }

    const {
      sourceReceiptId,
      bridgeCores,
      belowDeckPolicies,
      loadouts,
      sourceMeta,
    } = req.body ?? {};

    if (!Number.isInteger(sourceReceiptId) || sourceReceiptId < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "sourceReceiptId must be a positive integer", 400);
    }

    const receiptStore = appState.receiptStoreFactory?.forUser(userId) ?? appState.receiptStore;
    if (!receiptStore) {
      return sendFail(res, ErrorCode.RECEIPT_STORE_NOT_AVAILABLE, "Receipt store not available", 503);
    }
    const sourceReceipt = await receiptStore.getReceipt(sourceReceiptId);
    if (!sourceReceipt) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Source receipt ${sourceReceiptId} not found`, 404);
    }
    if (sourceReceipt.layer !== "ownership") {
      return sendFail(res, ErrorCode.INVALID_PARAM, "sourceReceiptId must reference an ownership-layer receipt", 400);
    }

    const bridgeCoreInputs = Array.isArray(bridgeCores) ? (bridgeCores as CompositionBridgeCoreInput[]) : [];
    const belowDeckPolicyInputs = Array.isArray(belowDeckPolicies) ? (belowDeckPolicies as CompositionBelowDeckPolicyInput[]) : [];
    const loadoutInputs = Array.isArray(loadouts) ? (loadouts as CompositionLoadoutInput[]) : [];

    if (bridgeCoreInputs.length + belowDeckPolicyInputs.length + loadoutInputs.length === 0) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "At least one accepted suggestion is required", 400);
    }

    const bridgeKeySet = new Set<string>();
    for (const input of bridgeCoreInputs) {
      if (!input || typeof input !== "object") {
        return sendFail(res, ErrorCode.INVALID_PARAM, "bridgeCores entries must be objects", 400);
      }
      if (typeof input.key !== "string" || input.key.trim().length === 0 || input.key.length > 100) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "bridge core key must be 1-100 characters", 400);
      }
      if (bridgeKeySet.has(input.key)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Duplicate bridge core key: ${input.key}`, 400);
      }
      bridgeKeySet.add(input.key);
      if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 200) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "bridge core name must be 1-200 characters", 400);
      }
      if (!Array.isArray(input.members) || input.members.length === 0 || input.members.length > 3) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "bridge core members must have 1-3 entries", 400);
      }
      for (const member of input.members) {
        if (!member || typeof member !== "object") {
          return sendFail(res, ErrorCode.INVALID_PARAM, "bridge core member must be an object", 400);
        }
        if (typeof member.officerId !== "string" || member.officerId.length === 0 || member.officerId.length > 200) {
          return sendFail(res, ErrorCode.INVALID_PARAM, "bridge core member officerId must be 1-200 characters", 400);
        }
        if (member.slot !== "captain" && member.slot !== "bridge_1" && member.slot !== "bridge_2") {
          return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid bridge slot: ${String(member.slot)}`, 400);
        }
      }
    }

    const policyKeySet = new Set<string>();
    for (const input of belowDeckPolicyInputs) {
      if (!input || typeof input !== "object") {
        return sendFail(res, ErrorCode.INVALID_PARAM, "belowDeckPolicies entries must be objects", 400);
      }
      if (typeof input.key !== "string" || input.key.trim().length === 0 || input.key.length > 100) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "below deck policy key must be 1-100 characters", 400);
      }
      if (policyKeySet.has(input.key)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Duplicate below deck policy key: ${input.key}`, 400);
      }
      policyKeySet.add(input.key);
      if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 200) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "below deck policy name must be 1-200 characters", 400);
      }
      if (input.mode !== "stats_then_bda" && input.mode !== "pinned_only" && input.mode !== "stat_fill_only") {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid below deck policy mode: ${String(input.mode)}`, 400);
      }
      if (input.spec !== undefined && (typeof input.spec !== "object" || input.spec === null)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "below deck policy spec must be an object", 400);
      }
    }

    for (const input of loadoutInputs) {
      if (!input || typeof input !== "object") {
        return sendFail(res, ErrorCode.INVALID_PARAM, "loadouts entries must be objects", 400);
      }
      if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 200) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "loadout name must be 1-200 characters", 400);
      }
      if (typeof input.shipId !== "string" || input.shipId.length === 0 || input.shipId.length > 200) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "loadout shipId must be 1-200 characters", 400);
      }
      if (input.bridgeCoreKey !== undefined && !bridgeKeySet.has(input.bridgeCoreKey)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Unknown bridgeCoreKey: ${input.bridgeCoreKey}`, 400);
      }
      if (input.belowDeckPolicyKey !== undefined && !policyKeySet.has(input.belowDeckPolicyKey)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Unknown belowDeckPolicyKey: ${input.belowDeckPolicyKey}`, 400);
      }
      if (input.intentKeys !== undefined && (!Array.isArray(input.intentKeys) || input.intentKeys.some((v) => typeof v !== "string" || v.length > 100))) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "loadout intentKeys must be a string[] with max length 100 each", 400);
      }
      if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((v) => typeof v !== "string" || v.length > 100))) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "loadout tags must be a string[] with max length 100 each", 400);
      }
    }

    const uniqueOfficerIds = [...new Set(bridgeCoreInputs.flatMap((input) => input.members.map((member) => member.officerId)))];
    const uniqueShipIds = [...new Set(loadoutInputs.map((input) => input.shipId))];

    const [officerChecks, shipChecks] = await Promise.all([
      Promise.all(uniqueOfficerIds.map(async (id) => ({ id, found: !!(await appState.referenceStore!.getOfficer(id)) }))),
      Promise.all(uniqueShipIds.map(async (id) => ({ id, found: !!(await appState.referenceStore!.getShip(id)) }))),
    ]);

    const missingOfficers = officerChecks.filter((entry) => !entry.found).map((entry) => entry.id);
    const missingShips = shipChecks.filter((entry) => !entry.found).map((entry) => entry.id);
    if (missingOfficers.length > 0 || missingShips.length > 0) {
      return sendFail(
        res,
        ErrorCode.INVALID_PARAM,
        `Unknown reference IDs in composition payload (officers: ${missingOfficers.join(", ") || "none"}; ships: ${missingShips.join(", ") || "none"})`,
        400,
      );
    }

    const compositionOutcome = await withUserScope(appState.pool, userId, async (client) => {
      const bridgeCoreByKey = new Map<string, number>();
      const policyByKey = new Map<string, number>();
      const now = new Date().toISOString();

      const changesAdded: Array<Record<string, unknown>> = [];
      const inverseRemoved: Array<Record<string, unknown>> = [];

      for (const input of bridgeCoreInputs) {
        const insertCore = await client.query<{ id: number; name: string }>(
          `INSERT INTO bridge_cores (user_id, name, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name`,
          [userId, input.name.trim(), input.notes?.trim() || null, now, now],
        );
        const bridgeCoreId = insertCore.rows[0].id;
        bridgeCoreByKey.set(input.key, bridgeCoreId);

        for (const member of input.members) {
          await client.query(
            `INSERT INTO bridge_core_members (user_id, bridge_core_id, officer_id, slot)
             VALUES ($1, $2, $3, $4)`,
            [userId, bridgeCoreId, member.officerId, member.slot],
          );
        }

        const item = { entityType: "bridge_core", id: bridgeCoreId, name: input.name.trim() };
        changesAdded.push(item);
        inverseRemoved.push(item);
      }

      for (const input of belowDeckPolicyInputs) {
        const insertPolicy = await client.query<{ id: number; name: string }>(
          `INSERT INTO below_deck_policies (user_id, name, mode, spec, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, name`,
          [userId, input.name.trim(), input.mode, JSON.stringify(input.spec ?? {}), input.notes?.trim() || null, now, now],
        );
        const policyId = insertPolicy.rows[0].id;
        policyByKey.set(input.key, policyId);

        const item = { entityType: "below_deck_policy", id: policyId, name: input.name.trim() };
        changesAdded.push(item);
        inverseRemoved.push(item);
      }

      for (const input of loadoutInputs) {
        const bridgeCoreId = input.bridgeCoreKey ? (bridgeCoreByKey.get(input.bridgeCoreKey) ?? null) : null;
        const belowDeckPolicyId = input.belowDeckPolicyKey ? (policyByKey.get(input.belowDeckPolicyKey) ?? null) : null;

        const insertLoadout = await client.query<{ id: number; name: string }>(
          `INSERT INTO loadouts (user_id, ship_id, bridge_core_id, below_deck_policy_id, name, priority, is_active, intent_keys, tags, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 0, TRUE, $6, $7, $8, $9, $10)
           RETURNING id, name`,
          [
            userId,
            input.shipId,
            bridgeCoreId,
            belowDeckPolicyId,
            input.name.trim(),
            JSON.stringify(input.intentKeys ?? []),
            JSON.stringify(input.tags ?? []),
            input.notes?.trim() || null,
            now,
            now,
          ],
        );
        const loadoutId = insertLoadout.rows[0].id;
        const item = { entityType: "loadout", id: loadoutId, name: input.name.trim() };
        changesAdded.push(item);
        inverseRemoved.push(item);
      }

      const receiptInsert = await client.query<{ id: number }>(
        `INSERT INTO import_receipts (user_id, source_type, source_meta, mapping, layer, changeset, inverse, unresolved, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
         RETURNING id`,
        [
          userId,
          "file_import",
          JSON.stringify({
            sourceReceiptId,
            step: "composition_inference",
            ...(typeof sourceMeta === "object" && sourceMeta ? sourceMeta : {}),
          }),
          null,
          "composition",
          JSON.stringify({ added: changesAdded, updated: [], removed: [] }),
          JSON.stringify({ added: [], updated: [], removed: inverseRemoved }),
          now,
        ],
      );

      return {
        receiptId: receiptInsert.rows[0].id,
        summary: {
          bridgeCores: bridgeCoreInputs.length,
          belowDeckPolicies: belowDeckPolicyInputs.length,
          loadouts: loadoutInputs.length,
        },
      };
    });

    return sendOk(res, {
      receipt: { id: compositionOutcome.receiptId },
      summary: compositionOutcome.summary,
    });
  });

  return router;
}
