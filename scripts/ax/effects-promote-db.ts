import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { ROOT, getFlag, hasFlag, makeResult, runCapture } from "./runner.js";
import { createPool, type PoolClient } from "../../src/server/db.js";
import { createEffectStore } from "../../src/server/stores/effect-store.js";
import {
  hashEffectsContractArtifact,
  stableJsonStringify,
  type EffectsContractArtifact,
} from "../../src/server/services/effects-contract-v3.js";
import { summarizeEffectsContractArtifact } from "./effects-harness.js";
import { evaluateActivationGates, type ActivationMetrics } from "./effects-gate-evaluator.js";

interface TaxonomySets {
  effectKeys: Set<string>;
  targetKinds: Set<string>;
  targetTags: Set<string>;
  conditionKeys: Set<string>;
}

interface ActiveBaselineRow {
  run_id: string;
  metrics_json: string | null;
}

const SLOT_ORDER: Record<string, number> = {
  cm: 0,
  oa: 1,
  bda: 2,
};

function usageHint(): string {
  return "Use: DATABASE_URL=<postgres-url> npm run ax -- effects:promote:db (--input <path> | --content-hash <sha256>) --run <runId> [--activate] [--profile local_dev|cloud_activation] [--dataset-kind deterministic|hybrid] [--activation-target local|cloud] [--smoke-base-url <url>]";
}

function isSorted(values: string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.localeCompare(values[index]!) > 0) return false;
  }
  return true;
}

function isSortedNatural(values: string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.localeCompare(values[index]!, undefined, { numeric: true }) > 0) return false;
  }
  return true;
}

function compareAbilityIds(leftAbilityId: string, rightAbilityId: string): number {
  const leftSlot = leftAbilityId.split(":").pop() ?? "";
  const rightSlot = rightAbilityId.split(":").pop() ?? "";
  const slotCmp = (SLOT_ORDER[leftSlot] ?? 99) - (SLOT_ORDER[rightSlot] ?? 99);
  if (slotCmp !== 0) return slotCmp;
  return leftAbilityId.localeCompare(rightAbilityId);
}

function isSortedByAbilityDeterministicOrder(values: string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compareAbilityIds(values[index - 1]!, values[index]!) > 0) return false;
  }
  return true;
}

async function findContractPathByHash(contentHash: string): Promise<string | null> {
  const runsRoot = resolve(ROOT, "tmp", "effects", "runs");
  let runDirs: string[] = [];
  try {
    const dirents = await readdir(runsRoot, { withFileTypes: true });
    runDirs = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return null;
  }

  const normalized = contentHash.toLowerCase();
  for (const runDir of runDirs) {
    const artifactsDir = resolve(runsRoot, runDir, "artifacts");
    try {
      const files = await readdir(artifactsDir);
      const hit = files.find((file) => file.startsWith("effects-contract.v3.") && file.endsWith(".json") && normalized.startsWith(file.replace("effects-contract.v3.", "").replace(".json", "")));
      if (hit) return resolve(artifactsDir, hit);
    } catch {
      // ignore and continue
    }
  }

  return null;
}

function deriveMetrics(artifact: EffectsContractArtifact): ActivationMetrics {
  const summary = summarizeEffectsContractArtifact(artifact);
  const mappedAbilitiesCount = Math.max(0, summary.abilities - summary.unmappedEntries);
  const mappedAbilitiesPercent = summary.abilities > 0
    ? (mappedAbilitiesCount / summary.abilities) * 100
    : 0;
  const inferredPromotedCount = artifact.officers
    .flatMap((officer) => officer.abilities)
    .flatMap((ability) => ability.effects)
    .filter((effect) => effect.inferred && effect.promotionReceiptId != null).length;
  const inferredPromotedRatio = summary.effects > 0 ? inferredPromotedCount / summary.effects : 0;

  return {
    officerCount: summary.officers,
    abilityCount: summary.abilities,
    mappedAbilitiesCount,
    mappedAbilitiesPercent,
    unmappedEntries: summary.unmappedEntries,
    inferredPromotedRatio,
  };
}

function assertDeterministicOrdering(artifact: EffectsContractArtifact): string[] {
  const errors: string[] = [];
  const officerIds = artifact.officers.map((officer) => officer.officerId);
  if (!isSorted(officerIds)) errors.push("officers are not sorted by officerId");

  for (const officer of artifact.officers) {
    const abilityIds = officer.abilities.map((ability) => ability.abilityId);
    if (!isSortedByAbilityDeterministicOrder(abilityIds)) {
      errors.push(`abilities are not sorted for officer ${officer.officerId}`);
      continue;
    }
    for (const ability of officer.abilities) {
      const effectIds = ability.effects.map((effect) => effect.effectId);
      if (!isSortedNatural(effectIds)) {
        errors.push(`effects are not sorted for ability ${ability.abilityId}`);
      }
    }
  }

  return errors;
}

function parseBaselineMetrics(row: ActiveBaselineRow | undefined): ActivationMetrics | null {
  if (!row?.metrics_json) return null;
  try {
    const parsed = JSON.parse(row.metrics_json) as Partial<ActivationMetrics>;
    const numeric = (value: unknown): number | null => {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return value;
    };

    const officerCount = numeric(parsed.officerCount);
    const abilityCount = numeric(parsed.abilityCount);
    const mappedAbilitiesCount = numeric(parsed.mappedAbilitiesCount);
    const mappedAbilitiesPercent = numeric(parsed.mappedAbilitiesPercent);
    const unmappedEntries = numeric(parsed.unmappedEntries);
    const inferredPromotedRatio = numeric(parsed.inferredPromotedRatio);

    if (
      officerCount === null
      || abilityCount === null
      || mappedAbilitiesCount === null
      || mappedAbilitiesPercent === null
      || unmappedEntries === null
      || inferredPromotedRatio === null
    ) {
      return null;
    }

    return {
      officerCount,
      abilityCount,
      mappedAbilitiesCount,
      mappedAbilitiesPercent,
      unmappedEntries,
      inferredPromotedRatio,
    };
  } catch {
    return null;
  }
}

async function loadTaxonomySets(client: PoolClient): Promise<TaxonomySets> {
  const [effectKeys, targetKinds, targetTags, conditionKeys] = await Promise.all([
    client.query<{ id: string }>("SELECT id FROM taxonomy_effect_key"),
    client.query<{ id: string }>("SELECT id FROM taxonomy_target_kind"),
    client.query<{ id: string }>("SELECT id FROM taxonomy_target_tag"),
    client.query<{ id: string }>("SELECT id FROM taxonomy_condition_key"),
  ]);

  return {
    effectKeys: new Set(effectKeys.rows.map((row) => row.id)),
    targetKinds: new Set(targetKinds.rows.map((row) => row.id)),
    targetTags: new Set(targetTags.rows.map((row) => row.id)),
    conditionKeys: new Set(conditionKeys.rows.map((row) => row.id)),
  };
}

function validateTaxonomyRefs(artifact: EffectsContractArtifact, taxonomySets: TaxonomySets): string[] {
  const errors: string[] = [];

  for (const officer of artifact.officers) {
    for (const ability of officer.abilities) {
      for (const effect of ability.effects) {
        if (!taxonomySets.effectKeys.has(effect.effectKey)) {
          errors.push(`unknown effectKey '${effect.effectKey}' for ${ability.abilityId}`);
        }
        for (const targetKind of effect.targets.targetKinds) {
          if (!taxonomySets.targetKinds.has(targetKind)) {
            errors.push(`unknown targetKind '${targetKind}' for ${ability.abilityId}`);
          }
        }
        for (const targetTag of effect.targets.targetTags) {
          if (!taxonomySets.targetTags.has(targetTag)) {
            errors.push(`unknown targetTag '${targetTag}' for ${ability.abilityId}`);
          }
        }
        for (const condition of effect.conditions) {
          if (!taxonomySets.conditionKeys.has(condition.conditionKey)) {
            errors.push(`unknown conditionKey '${condition.conditionKey}' for ${ability.abilityId}`);
          }
        }
      }
    }
  }

  return [...new Set(errors)].slice(0, 100);
}

const command: AxCommand = {
  name: "effects:promote:db",
  description: "Promote effects contract artifact into DB runtime dataset tables",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const runId = getFlag(args, "run");
    const inputPathFlag = getFlag(args, "input");
    const contentHashFlag = getFlag(args, "content-hash");
    const activate = hasFlag(args, "activate");
    const activationTarget = (getFlag(args, "activation-target") ?? "local").toLowerCase();
    const smokeBaseUrl = getFlag(args, "smoke-base-url");
    const profile = getFlag(args, "profile") ?? undefined;
    const datasetKind = getFlag(args, "dataset-kind") ?? "hybrid";
    const dbUrlFlag = getFlag(args, "db-url");
    if (dbUrlFlag) {
      return makeResult("effects:promote:db", start, {}, {
        success: false,
        errors: ["--db-url is disabled for security; use DATABASE_URL environment variable"],
        hints: ["Example: DATABASE_URL=<postgres-url> npm run ax -- effects:promote:db --input <path> --run <runId> --dataset-kind hybrid"],
      });
    }
    const dbUrl = process.env.DATABASE_URL ?? "postgres://majel:majel@localhost:5432/majel";

    if (!runId) {
      return makeResult("effects:promote:db", start, {}, {
        success: false,
        errors: ["Missing required flag: --run <runId>"],
        hints: [usageHint()],
      });
    }

    if (!inputPathFlag && !contentHashFlag) {
      return makeResult("effects:promote:db", start, { runId }, {
        success: false,
        errors: ["Provide --input <path> or --content-hash <sha256>"],
        hints: [usageHint()],
      });
    }

    const resolvedInputPath = inputPathFlag
      ? resolve(ROOT, inputPathFlag)
      : await findContractPathByHash(contentHashFlag!);

    if (!resolvedInputPath) {
      return makeResult("effects:promote:db", start, {
        runId,
        contentHash: contentHashFlag ?? null,
      }, {
        success: false,
        errors: ["Unable to resolve input artifact path from provided content hash"],
      });
    }

    let artifact: EffectsContractArtifact;
    try {
      const raw = await readFile(resolvedInputPath, "utf-8");
      artifact = JSON.parse(raw) as EffectsContractArtifact;
    } catch (error) {
      return makeResult("effects:promote:db", start, {
        runId,
        inputPath: resolvedInputPath,
      }, {
        success: false,
        errors: [error instanceof Error ? `Failed reading artifact: ${error.message}` : "Failed reading artifact"],
      });
    }

    const computedHash = hashEffectsContractArtifact(artifact);
    if (contentHashFlag && computedHash !== contentHashFlag) {
      return makeResult("effects:promote:db", start, {
        runId,
        inputPath: resolvedInputPath,
        computedHash,
        expectedHash: contentHashFlag,
      }, {
        success: false,
        errors: ["content hash mismatch between flag and artifact bytes"],
      });
    }

    const orderingErrors = assertDeterministicOrdering(artifact);
    if (orderingErrors.length > 0) {
      return makeResult("effects:promote:db", start, {
        runId,
        inputPath: resolvedInputPath,
        orderingErrors,
      }, {
        success: false,
        errors: ["deterministic ordering check failed"],
      });
    }

    const metrics = deriveMetrics(artifact);
    const sourceLabel = getFlag(args, "source-label") ?? "effects-build";
    const sourceVersion = getFlag(args, "source-version") ?? null;
    const snapshotId = getFlag(args, "snapshot-id") ?? artifact.source.snapshotVersion ?? null;

    const adminPool = createPool(dbUrl);
    const pool = createPool(dbUrl);
    let insertedAbilityCount = 0;
    let insertedEffectCount = 0;
    let insertedConditionCount = 0;
    let insertedTargetKindCount = 0;
    let insertedTargetTagCount = 0;

    try {
      const prereq = await adminPool.query<{ exists: boolean }>(
        `SELECT to_regclass('public.reference_officers') IS NOT NULL AS exists`,
      );
      if (!prereq.rows[0]?.exists) {
        return makeResult("effects:promote:db", start, {
          runId,
          inputPath: resolvedInputPath,
        }, {
          success: false,
          errors: ["Missing prerequisite table: reference_officers"],
          hints: [
            "Run canonical seed/bootstrap first so reference officer IDs exist",
            "Example: npm run cloud:db:seed:canonical (cloud) or start server boot locally",
          ],
        });
      }

      await createEffectStore(adminPool, pool);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const taxonomySets = await loadTaxonomySets(client);
        const taxonomyErrors = validateTaxonomyRefs(artifact, taxonomySets);
        if (taxonomyErrors.length > 0) {
          throw new Error(`taxonomy reference validation failed: ${taxonomyErrors.slice(0, 5).join("; ")}`);
        }

        await client.query(
          `DELETE FROM catalog_ability_effect_condition
           WHERE ability_effect_id IN (
             SELECT id FROM catalog_ability_effect WHERE run_id = $1
           )`,
          [runId],
        );
        await client.query(
          `DELETE FROM catalog_ability_effect_target_kind
           WHERE ability_effect_id IN (
             SELECT id FROM catalog_ability_effect WHERE run_id = $1
           )`,
          [runId],
        );
        await client.query(
          `DELETE FROM catalog_ability_effect_target_tag
           WHERE ability_effect_id IN (
             SELECT id FROM catalog_ability_effect WHERE run_id = $1
           )`,
          [runId],
        );
        await client.query("DELETE FROM catalog_ability_effect WHERE run_id = $1", [runId]);
        await client.query("DELETE FROM catalog_officer_ability WHERE run_id = $1", [runId]);

        for (const officer of artifact.officers) {
          for (const ability of officer.abilities) {
            const scopedAbilityId = `${runId}:${ability.abilityId}`;
            const abilityInsert = await client.query(
              `INSERT INTO catalog_officer_ability (id, run_id, officer_id, slot, name, raw_text, is_inert)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (id) DO UPDATE SET
                 run_id = EXCLUDED.run_id,
                 officer_id = EXCLUDED.officer_id,
                 slot = EXCLUDED.slot,
                 name = EXCLUDED.name,
                 raw_text = EXCLUDED.raw_text,
                 is_inert = EXCLUDED.is_inert`,
              [scopedAbilityId, runId, officer.officerId, ability.slot, ability.name, ability.rawText, ability.isInert],
            );
            if (abilityInsert.rowCount && abilityInsert.rowCount > 0) insertedAbilityCount += 1;

            for (const effect of ability.effects) {
              const scopedEffectId = `${runId}:${effect.effectId}`;
              const effectInsert = await client.query(
                `INSERT INTO catalog_ability_effect (id, run_id, ability_id, effect_key, magnitude, unit, stacking)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO UPDATE SET
                   run_id = EXCLUDED.run_id,
                   ability_id = EXCLUDED.ability_id,
                   effect_key = EXCLUDED.effect_key,
                   magnitude = EXCLUDED.magnitude,
                   unit = EXCLUDED.unit,
                   stacking = EXCLUDED.stacking`,
                [scopedEffectId, runId, scopedAbilityId, effect.effectKey, effect.magnitude, effect.unit, effect.stacking],
              );
              if (effectInsert.rowCount && effectInsert.rowCount > 0) insertedEffectCount += 1;

              for (const targetKind of effect.targets.targetKinds) {
                const targetKindInsert = await client.query(
                  `INSERT INTO catalog_ability_effect_target_kind (ability_effect_id, target_kind)
                   VALUES ($1, $2)
                   ON CONFLICT (ability_effect_id, target_kind) DO NOTHING`,
                  [scopedEffectId, targetKind],
                );
                if (targetKindInsert.rowCount && targetKindInsert.rowCount > 0) insertedTargetKindCount += 1;
              }

              for (const targetTag of effect.targets.targetTags) {
                const targetTagInsert = await client.query(
                  `INSERT INTO catalog_ability_effect_target_tag (ability_effect_id, target_tag)
                   VALUES ($1, $2)
                   ON CONFLICT (ability_effect_id, target_tag) DO NOTHING`,
                  [scopedEffectId, targetTag],
                );
                if (targetTagInsert.rowCount && targetTagInsert.rowCount > 0) insertedTargetTagCount += 1;
              }

              for (let conditionIndex = 0; conditionIndex < effect.conditions.length; conditionIndex += 1) {
                const condition = effect.conditions[conditionIndex]!;
                const conditionId = `${scopedEffectId}:cond:${conditionIndex}`;
                const condInsert = await client.query(
                  `INSERT INTO catalog_ability_effect_condition (id, ability_effect_id, condition_key, params_json)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (id) DO UPDATE SET
                     ability_effect_id = EXCLUDED.ability_effect_id,
                     condition_key = EXCLUDED.condition_key,
                     params_json = EXCLUDED.params_json`,
                  [conditionId, scopedEffectId, condition.conditionKey, condition.params ? stableJsonStringify(condition.params) : null],
                );
                if (condInsert.rowCount && condInsert.rowCount > 0) insertedConditionCount += 1;
              }
            }
          }
        }

        const countResult = await client.query<{
          officer_count: string;
          ability_count: string;
          effect_count: string;
        }>(
          `SELECT
             COUNT(DISTINCT officer_id)::text AS officer_count,
             COUNT(*)::text AS ability_count,
             (
               SELECT COUNT(*)::text
               FROM catalog_ability_effect
               WHERE run_id = $1
             ) AS effect_count
           FROM catalog_officer_ability
           WHERE run_id = $1`,
          [runId],
        );

        const countedOfficers = Number.parseInt(countResult.rows[0]?.officer_count ?? "0", 10);
        const countedAbilities = Number.parseInt(countResult.rows[0]?.ability_count ?? "0", 10);
        const countedEffects = Number.parseInt(countResult.rows[0]?.effect_count ?? "0", 10);

        const summary = summarizeEffectsContractArtifact(artifact);
        if (
          countedOfficers !== metrics.officerCount
          || countedAbilities !== metrics.abilityCount
          || countedEffects !== summary.effects
        ) {
          throw new Error(
            `post-load count mismatch: officers=${countedOfficers}/${metrics.officerCount}, abilities=${countedAbilities}/${metrics.abilityCount}, effects=${countedEffects}/${summary.effects}`,
          );
        }

        await client.query(
          `INSERT INTO effect_dataset_run (
             run_id, content_hash, dataset_kind, source_label, source_version, snapshot_id,
             status, metrics_json, metadata_json
           ) VALUES ($1, $2, $3, $4, $5, $6, 'staged', $7, $8)
           ON CONFLICT (run_id) DO UPDATE SET
             content_hash = EXCLUDED.content_hash,
             dataset_kind = EXCLUDED.dataset_kind,
             source_label = EXCLUDED.source_label,
             source_version = EXCLUDED.source_version,
             snapshot_id = EXCLUDED.snapshot_id,
             status = 'staged',
             metrics_json = EXCLUDED.metrics_json,
             metadata_json = EXCLUDED.metadata_json`,
          [
            runId,
            computedHash,
            datasetKind,
            sourceLabel,
            sourceVersion,
            snapshotId,
            stableJsonStringify(metrics),
            stableJsonStringify({
              sourcePath: resolvedInputPath,
              activationRequested: activate,
            }),
          ],
        );

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      let gateResult: Awaited<ReturnType<typeof evaluateActivationGates>> | null = null;
      let activationApplied = false;
      let smokeResult: { target: string; baseUrl: string | null; exitCode: number } | null = null;

      if (activate) {
        if (activationTarget !== "local" && activationTarget !== "cloud") {
          return makeResult("effects:promote:db", start, {
            runId,
            activationTarget,
          }, {
            success: false,
            errors: ["Invalid activation target; use local or cloud"],
            hints: [usageHint()],
          });
        }

        if (activationTarget === "cloud") {
          const smokeCmd = [
            "scripts/ax.ts",
            "effects:activation:smoke",
            "--target",
            "cloud",
          ];
          if (smokeBaseUrl) smokeCmd.push("--base-url", smokeBaseUrl);
          const smokeExec = runCapture("tsx", smokeCmd, { ignoreExit: true });
          smokeResult = {
            target: "cloud",
            baseUrl: smokeBaseUrl ?? process.env.MAJEL_CLOUD_URL ?? process.env.MAJEL_BASE_URL ?? null,
            exitCode: smokeExec.exitCode,
          };
          if (smokeExec.exitCode !== 0) {
            return makeResult("effects:promote:db", start, {
              runId,
              activation: {
                requested: true,
                target: activationTarget,
                smoke: smokeResult,
              },
              inputPath: resolvedInputPath,
            }, {
              success: false,
              errors: ["Cloud activation smoke precondition failed"],
              hints: ["Run: npm run ax -- effects:activation:smoke --target cloud --base-url <service-url>"],
            });
          }
        }

        const baselineResult = await pool.query<ActiveBaselineRow>(
          `SELECT r.run_id, r.metrics_json
           FROM effect_dataset_active a
           JOIN effect_dataset_run r ON r.run_id = a.run_id
           WHERE a.scope = 'global'`,
        );

        const baselineRow = baselineResult.rows[0];
        const baselineMetrics = parseBaselineMetrics(baselineRow);
        gateResult = await evaluateActivationGates({
          datasetKind,
          profile,
          metrics,
          baselineMetrics,
        });

        if (gateResult.ok) {
          const activationClient = await pool.connect();
          try {
            await activationClient.query("BEGIN");
            await activationClient.query(
              `UPDATE effect_dataset_run
               SET status = 'retired'
               WHERE status = 'active' AND run_id <> $1`,
              [runId],
            );
            await activationClient.query(
              `UPDATE effect_dataset_run
               SET status = 'active', activated_at = NOW()
               WHERE run_id = $1`,
              [runId],
            );
            await activationClient.query(
              `INSERT INTO effect_dataset_active (scope, run_id, updated_at)
               VALUES ('global', $1, NOW())
               ON CONFLICT (scope) DO UPDATE SET
                 run_id = EXCLUDED.run_id,
                 updated_at = NOW()`,
              [runId],
            );
            await activationClient.query("COMMIT");
            activationApplied = true;
          } catch (error) {
            await activationClient.query("ROLLBACK");
            throw error;
          } finally {
            activationClient.release();
          }
        }
      }

      return makeResult("effects:promote:db", start, {
        runId,
        inputPath: resolvedInputPath,
        contentHash: computedHash,
        datasetKind,
        summary: summarizeEffectsContractArtifact(artifact),
        metrics,
        inserted: {
          abilities: insertedAbilityCount,
          effects: insertedEffectCount,
          targetKinds: insertedTargetKindCount,
          targetTags: insertedTargetTagCount,
          conditions: insertedConditionCount,
        },
        activation: {
          requested: activate,
          target: activationTarget,
          smoke: smokeResult,
          applied: activationApplied,
          gate: gateResult,
        },
      }, {
        success: !activate || activationApplied,
        errors: activate && !activationApplied
          ? ["Activation blocked by gate evaluation"]
          : undefined,
      });
    } catch (error) {
      return makeResult("effects:promote:db", start, {
        runId,
        inputPath: resolvedInputPath,
      }, {
        success: false,
        errors: [error instanceof Error ? error.message : "effects promote failed"],
        hints: [usageHint()],
      });
    } finally {
      await adminPool.end();
      await pool.end();
    }
  },
};

export default command;
