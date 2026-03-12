/**
 * cloud-sql.ts — Cloud SQL operations: auth, seed, effects snapshot, wipe, count, reset
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  AX_MODE,
  type AuthorizedNetworkEntry,
  PROJECT,
  ROOT,
  axOutput,
  gcloud,
  gcloudJson,
  getFlagValue,
  humanError,
  humanLog,
  runCapture,
} from "./cloud-cli.js";
import { stableJsonStringify } from "../../src/server/services/effects-contract-v3.js";

// ─── Cloud SQL Helpers ──────────────────────────────────────────

function getCloudDbPassword(): string {
  return runCapture(`gcloud secrets versions access latest --secret=cloudsql-password --project ${PROJECT}`);
}

function getCloudSqlPrimaryIp(): string {
  const instance = gcloudJson<{ ipAddresses?: Array<{ type?: string; ipAddress?: string }> }>(`sql instances describe majel-pg --project ${PROJECT}`);
  const publicIp = instance.ipAddresses?.find(ip => ip.type === "PRIMARY")?.ipAddress;
  if (!publicIp) {
    throw new Error("Could not find Cloud SQL public IP");
  }
  return publicIp;
}

export function getCloudDbUrl(): string {
  const password = encodeURIComponent(getCloudDbPassword());
  const publicIp = getCloudSqlPrimaryIp();
  return `postgresql://postgres:${password}@${publicIp}:5432/majel`;
}

function getCloudSqlAuthorizedNetworks(): AuthorizedNetworkEntry[] {
  const instance = gcloudJson<{
    settings?: { ipConfiguration?: { authorizedNetworks?: AuthorizedNetworkEntry[] } };
  }>(`sql instances describe majel-pg --project ${PROJECT}`);
  return instance.settings?.ipConfiguration?.authorizedNetworks ?? [];
}

function detectPublicIpv4(): string {
  const ip = runCapture("curl -4 -fsS https://ifconfig.me").trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    throw new Error(`Could not determine a valid public IPv4 address (got: ${ip || "empty"})`);
  }
  return ip;
}

function normalizeAuthorizedNetwork(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Authorized network value cannot be empty");
  }
  return trimmed.includes("/") ? trimmed : `${trimmed}/32`;
}

// ─── Canonical Seed ─────────────────────────────────────────────

export function runCanonicalSeedScript(start: number, commandName: string): { output: string } {
  const password = getCloudDbPassword();
  const publicIp = getCloudSqlPrimaryIp();

  humanLog(`   Connecting to ${publicIp}:5432...`);

  const env = {
    ...process.env,
    CLOUD_DB_HOST: publicIp,
    CLOUD_DB_PORT: "5432",
    CLOUD_DB_PASSWORD: password,
  };

  const result = spawnSync("npx", ["tsx", "scripts/seed-cloud-db.ts"], {
    cwd: process.cwd(),
    env,
    stdio: AX_MODE ? "pipe" : "inherit",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    if (AX_MODE) {
      axOutput(commandName, start, { status: "failed" }, {
        success: false,
        errors: ["Seed script failed", result.stderr || "Unknown error"],
        hints: ["Ensure IP is authorized: npm run cloud:db:auth", "Check CDN snapshot exists: data/.stfc-snapshot/"],
      });
    } else {
      humanError("❌ Seed failed");
    }
    process.exit(1);
  }

  return { output: result.stdout || "" };
}

// ─── Effects Snapshot ───────────────────────────────────────────

interface CdnAbilityRef {
  id?: number | null;
  loca_id?: number | null;
  value_is_percentage?: boolean;
}

interface CdnOfficerSummaryItem {
  id: number;
  captain_ability?: CdnAbilityRef | null;
  ability?: CdnAbilityRef | null;
  below_decks_ability?: CdnAbilityRef | null;
}

interface TranslationEntry {
  id: number | null;
  key: string;
  text: string;
}

interface EffectsSnapshotExportOfficer {
  officerId: string;
  abilities: Array<{
    abilityId: string;
    slot: "cm" | "oa" | "bda";
    name: string | null;
    rawText: string;
    isInert: boolean;
    sourceRef: string;
  }>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripColorTags(text: string): string {
  return text.replace(/<\/?color[^>]*>/gi, "").replace(/<\/?size[^>]*>/gi, "").replace(/<\/?sprite[^>]*>/gi, "");
}

function sanitizeSnapshotText(text: string | undefined): string {
  if (!text) return "";
  return stripColorTags(text)
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTranslationMap(entries: TranslationEntry[], key: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const entry of entries) {
    if (entry.id != null && entry.key === key) {
      map.set(entry.id, entry.text);
    }
  }
  return map;
}

function buildEffectsSnapshotFromCdn(): { path: string; officerCount: number; abilityCount: number; snapshotVersion: string } {
  const snapshotRoot = resolve(ROOT, "data", ".stfc-snapshot");
  const summaryPath = resolve(snapshotRoot, "officer", "summary.json");
  const versionPath = resolve(snapshotRoot, "version.txt");
  const buffsPath = resolve(snapshotRoot, "translations", "en", "officer_buffs.json");

  if (!existsSync(summaryPath)) {
    throw new Error("Missing CDN officer summary: data/.stfc-snapshot/officer/summary.json");
  }
  if (!existsSync(versionPath)) {
    throw new Error("Missing CDN snapshot version file: data/.stfc-snapshot/version.txt");
  }
  if (!existsSync(buffsPath)) {
    throw new Error("Missing CDN translations file: data/.stfc-snapshot/translations/en/officer_buffs.json");
  }

  const snapshotVersion = readFileSync(versionPath, "utf-8").trim() || "unknown";
  const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as CdnOfficerSummaryItem[];
  const buffEntries = JSON.parse(readFileSync(buffsPath, "utf-8")) as TranslationEntry[];

  const abilityNameMap = buildTranslationMap(buffEntries, "officer_ability_name");
  const abilityDescMap = buildTranslationMap(buffEntries, "officer_ability_desc");

  const officers: EffectsSnapshotExportOfficer[] = [];
  const slots: Array<{ key: "captain_ability" | "ability" | "below_decks_ability"; slot: "cm" | "oa" | "bda" }> = [
    { key: "captain_ability", slot: "cm" },
    { key: "ability", slot: "oa" },
    { key: "below_decks_ability", slot: "bda" },
  ];

  for (const officer of summary) {
    const officerId = `cdn:officer:${officer.id}`;
    const abilities: EffectsSnapshotExportOfficer["abilities"] = [];

    for (const slotDef of slots) {
      const abilityRef = officer[slotDef.key];
      const abilityLocaId = abilityRef?.loca_id ?? null;
      const abilityGameId = abilityRef?.id ?? null;
      if (!abilityLocaId || !abilityGameId) continue;

      const name = abilityNameMap.get(abilityLocaId) ?? null;
      const rawText = sanitizeSnapshotText(abilityDescMap.get(abilityLocaId));
      const isInert = rawText.length === 0 || /^unknown/i.test(rawText);

      abilities.push({
        abilityId: `${officerId}:${slotDef.slot}:${abilityGameId}`,
        slot: slotDef.slot,
        name,
        rawText,
        isInert,
        sourceRef: `data/.stfc-snapshot/officer/summary.json#/officerId/${officer.id}/${slotDef.key}`,
      });
    }

    officers.push({ officerId, abilities });
  }

  officers.sort((left, right) => left.officerId.localeCompare(right.officerId));
  for (const officer of officers) {
    officer.abilities.sort((left, right) => left.abilityId.localeCompare(right.abilityId));
  }

  const schemaDescriptor = {
    schemaVersion: "1.0.0",
    snapshot: {
      snapshotId: "string",
      source: "cdn-snapshot",
      sourceVersion: "string",
      generatedAt: "iso8601",
      schemaHash: "sha256",
      contentHash: "sha256",
    },
    officers: [{
      officerId: "string",
      abilities: [{
        abilityId: "string",
        slot: "cm|oa|bda",
        name: "string|null",
        rawText: "string",
        isInert: "boolean",
        sourceRef: "string",
      }],
    }],
  } as const;

  const generatedAt = new Date().toISOString();
  const schemaHash = sha256Hex(stableJsonStringify(schemaDescriptor));
  const snapshotId = `cdn-${snapshotVersion}`;
  const contentHash = sha256Hex(stableJsonStringify({
    schemaVersion: "1.0.0",
    snapshot: {
      snapshotId,
      source: "cdn-snapshot",
      sourceVersion: snapshotVersion,
      schemaHash,
    },
    officers,
  }));

  const payload = {
    schemaVersion: "1.0.0" as const,
    snapshot: {
      snapshotId,
      source: "cdn-snapshot",
      sourceVersion: snapshotVersion,
      generatedAt,
      schemaHash,
      contentHash,
    },
    officers,
  };

  const outDir = resolve(ROOT, "tmp", "effects", "exports");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `effects-snapshot.cdn-${snapshotVersion}.json`);
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  const abilityCount = officers.reduce((sum, officer) => sum + officer.abilities.length, 0);
  return {
    path: outPath,
    officerCount: officers.length,
    abilityCount,
    snapshotVersion,
  };
}

function runEffectsBuild(start: number, commandName: string): { mode: "deterministic" | "hybrid"; inputPath?: string; snapshotVersion?: string; axData: Record<string, unknown> } {
  const args = process.argv.slice(2);
  const modeRaw = getFlagValue(args, "mode") || "hybrid";
  if (modeRaw !== "deterministic" && modeRaw !== "hybrid") {
    if (AX_MODE) {
      axOutput(commandName, start, { status: "failed" }, {
        success: false,
        errors: [`Invalid mode '${modeRaw}'`],
        hints: ["Use --mode=deterministic or --mode=hybrid"],
      });
    } else {
      humanError(`❌ Invalid mode '${modeRaw}'. Use --mode=deterministic or --mode=hybrid`);
    }
    process.exit(1);
  }

  const mode = modeRaw;
  let inputPath = getFlagValue(args, "input") || undefined;
  const snapshotVersion = getFlagValue(args, "snapshot") || undefined;

  let generatedInput: { path: string; officerCount: number; abilityCount: number; snapshotVersion: string } | undefined;
  if (!inputPath) {
    try {
      generatedInput = buildEffectsSnapshotFromCdn();
      inputPath = generatedInput.path;
      if (!AX_MODE) {
        humanLog(`   📦 Using CDN snapshot export: ${inputPath}`);
        humanLog(`   👥 Officers parsed: ${generatedInput.officerCount}, abilities parsed: ${generatedInput.abilityCount}`);
      }
    } catch (error) {
      if (AX_MODE) {
        axOutput(commandName, start, { status: "failed" }, {
          success: false,
          errors: [error instanceof Error ? `CDN snapshot export failed: ${error.message}` : "CDN snapshot export failed"],
          hints: ["Ensure data/.stfc-snapshot contains officer summary + translations", "Or provide --input=<snapshot export path>"],
        });
      } else {
        humanError(error instanceof Error ? `❌ ${error.message}` : "❌ CDN snapshot export failed");
      }
      process.exit(1);
    }
  }

  const buildArgs = ["tsx", "scripts/ax.ts", "effects:build", `--mode=${mode}`];
  if (inputPath) buildArgs.push(`--input=${inputPath}`);
  if (snapshotVersion) buildArgs.push(`--snapshot=${snapshotVersion}`);

  const result = spawnSync("npx", buildArgs, {
    cwd: process.cwd(),
    stdio: AX_MODE ? "pipe" : "inherit",
    encoding: "utf-8",
  });

  const raw = result.stdout?.trim() || "";
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = { rawOutput: raw };
    }
  }

  if (result.status !== 0) {
    if (AX_MODE) {
      const errors = Array.isArray(parsed.errors) ? parsed.errors.map(String) : [result.stderr || "effects:build failed"];
      const hints = Array.isArray(parsed.hints) ? parsed.hints.map(String) : ["Run: npm run ax -- effects:build --mode=hybrid"];
      axOutput(commandName, start, {
        status: "failed",
        mode,
        inputPath: inputPath ?? null,
        snapshotVersion: snapshotVersion ?? null,
        generatedInput: generatedInput ?? null,
      }, {
        success: false,
        errors,
        hints,
      });
    } else {
      humanError("❌ Effects generation failed");
    }
    process.exit(1);
  }

  if (!AX_MODE) {
    const data = (parsed.data && typeof parsed.data === "object") ? parsed.data as Record<string, unknown> : {};
    const runId = typeof data.runId === "string" ? data.runId : "unknown";
    const receiptPath = typeof data.receiptPath === "string" ? data.receiptPath : "(not reported)";
    humanLog(`   ✅ effects:build ${mode} complete (runId: ${runId})`);
    humanLog(`   📄 Receipt: ${receiptPath}`);
  }

  return {
    mode,
    inputPath,
    snapshotVersion,
    axData: {
      ...parsed,
      generatedInput,
    },
  };
}

// ─── Commands ───────────────────────────────────────────────────

export async function cmdDbAuth(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const requestedIp = getFlagValue(args, "ip");
  const requestedCidr = normalizeAuthorizedNetwork(requestedIp || detectPublicIpv4());
  const existing = getCloudSqlAuthorizedNetworks();
  const existingCidrs = existing
    .map((entry) => entry.value?.trim())
    .filter((value): value is string => Boolean(value));

  if (existingCidrs.includes(requestedCidr)) {
    if (AX_MODE) {
      axOutput("db:auth", start, {
        status: "unchanged",
        added: requestedCidr,
        authorizedNetworks: existing,
      });
    } else {
      humanLog(`✅ Cloud SQL already allows ${requestedCidr}`);
    }
    return;
  }

  const mergedCidrs = [...existingCidrs, requestedCidr].join(",");
  gcloud(`sql instances patch majel-pg --project ${PROJECT} --authorized-networks=${mergedCidrs} --quiet`);

  const updated = getCloudSqlAuthorizedNetworks();

  if (AX_MODE) {
    axOutput("db:auth", start, {
      status: "updated",
      added: requestedCidr,
      authorizedNetworks: updated,
    });
  } else {
    humanLog(`✅ Added Cloud SQL authorized network: ${requestedCidr}`);
  }
}

export async function cmdDbSeed(): Promise<void> {
  await cmdDbSeedCanonical();
}

export async function cmdDbSeedCanonical(): Promise<void> {
  const start = Date.now();

  humanLog("🌱 Seeding Cloud DB from CDN snapshot...");
  humanLog("────────────────────────────────────────");

  const result = runCanonicalSeedScript(start, "db:seed:canonical");

  if (AX_MODE) {
    axOutput("db:seed:canonical", start, { status: "completed", output: result.output });
  }
}

export async function cmdDbSeedEffects(): Promise<void> {
  const start = Date.now();

  humanLog("🧬 Building effects artifacts for cloud seed...");
  humanLog("──────────────────────────────────────────────");

  const build = runEffectsBuild(start, "db:seed:effects");

  if (AX_MODE) {
    axOutput("db:seed:effects", start, {
      status: "completed",
      mode: build.mode,
      inputPath: build.inputPath ?? null,
      snapshotVersion: build.snapshotVersion ?? null,
      effectsBuild: build.axData,
    });
  }
}

export async function cmdDbSeedAll(): Promise<void> {
  const start = Date.now();

  humanLog("🚀 Running effects generation + canonical cloud DB seed...");
  humanLog("────────────────────────────────────────────────────────────");

  const build = runEffectsBuild(start, "db:seed:all");
  const seed = runCanonicalSeedScript(start, "db:seed:all");

  if (AX_MODE) {
    axOutput("db:seed:all", start, {
      status: "completed",
      mode: build.mode,
      inputPath: build.inputPath ?? null,
      snapshotVersion: build.snapshotVersion ?? null,
      effectsBuild: build.axData,
      canonicalSeedOutput: seed.output,
    });
  }
}

export async function cmdDbWipe(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const force = args.includes("--force") || args.includes("-f");

  if (!force) {
    humanError("⚠️  This will DELETE ALL officers from the cloud database!");
    humanError("   Add --force to confirm");
    process.exit(1);
  }

  humanLog("🗑️  Wiping reference_officers table...");

  const password = runCapture(`gcloud secrets versions access latest --secret=cloudsql-password --project ${PROJECT}`);
  const instance = gcloudJson<{ ipAddresses?: Array<{ type?: string; ipAddress?: string }> }>(`sql instances describe majel-pg --project ${PROJECT}`);
  const publicIp = instance.ipAddresses?.find(ip => ip.type === "PRIMARY")?.ipAddress;

  if (!publicIp) {
    humanError("❌ Could not find Cloud SQL public IP");
    process.exit(1);
  }

  const wipeScript = `
import pg from "pg";
const pool = new pg.Pool({
  host: ${JSON.stringify(publicIp)},
  port: 5432,
  user: "postgres",
  password: process.env.CLOUD_DB_PASSWORD,
  database: "majel",
});
const result = await pool.query("DELETE FROM reference_officers");
console.log(JSON.stringify({ deleted: result.rowCount }));
await pool.end();
`;

  const tmpFile = resolve(process.cwd(), ".tmp-db-wipe.mts");
  writeFileSync(tmpFile, wipeScript);

  const result = spawnSync("npx", ["tsx", tmpFile], {
    cwd: process.cwd(),
    env: { ...process.env, CLOUD_DB_PASSWORD: password },
    stdio: "pipe",
    encoding: "utf-8",
  });

  try { unlinkSync(tmpFile); } catch { /* ignore */ }

  let deleted = 0;
  try {
    const output = JSON.parse(result.stdout);
    deleted = output.deleted || 0;
  } catch { /* ignore */ }

  if (AX_MODE) {
    axOutput("db:wipe", start, { deleted, status: result.status === 0 ? "completed" : "failed" });
  } else {
    humanLog(`✅ Deleted ${deleted} officers`);
  }
}

export async function cmdDbCount(): Promise<void> {
  const start = Date.now();

  const password = runCapture(`gcloud secrets versions access latest --secret=cloudsql-password --project ${PROJECT}`);
  const instance = gcloudJson<{ ipAddresses?: Array<{ type?: string; ipAddress?: string }> }>(`sql instances describe majel-pg --project ${PROJECT}`);
  const publicIp = instance.ipAddresses?.find(ip => ip.type === "PRIMARY")?.ipAddress;

  if (!publicIp) {
    humanError("❌ Could not find Cloud SQL public IP");
    process.exit(1);
  }

  const countScript = `
import pg from "pg";
const pool = new pg.Pool({
  host: ${JSON.stringify(publicIp)},
  port: 5432,
  user: "postgres",
  password: process.env.CLOUD_DB_PASSWORD,
  database: "majel",
});
const result = await pool.query(\`
  SELECT 
    (SELECT COUNT(*) FROM reference_officers) as officers,
    (SELECT COUNT(*) FROM reference_ships) as ships
\`);
console.log(JSON.stringify(result.rows[0]));
await pool.end();
`;

  const tmpFile = resolve(process.cwd(), ".tmp-db-count.mts");
  writeFileSync(tmpFile, countScript);

  const result = spawnSync("npx", ["tsx", tmpFile], {
    cwd: process.cwd(),
    env: { ...process.env, CLOUD_DB_PASSWORD: password },
    stdio: "pipe",
    encoding: "utf-8",
  });

  try { unlinkSync(tmpFile); } catch { /* ignore */ }

  let counts = { officers: 0, ships: 0 };
  try {
    counts = JSON.parse(result.stdout);
  } catch { /* ignore */ }

  if (AX_MODE) {
    axOutput("db:count", start, counts);
  } else {
    humanLog("📊 Cloud DB Counts");
    humanLog("────────────────────────────────────────");
    humanLog(`   Officers: ${counts.officers}`);
    humanLog(`   Ships:    ${counts.ships}`);
  }
}

export async function cmdDbResetCanonical(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const force = args.includes("--force") || args.includes("-f");
  const apply = args.includes("--apply");
  const confirmIndex = args.findIndex((value) => value === "--confirm");
  const confirmValue = confirmIndex >= 0 ? args[confirmIndex + 1] : undefined;

  if (!force || !apply || confirmValue !== "RESET_CANONICAL") {
    humanError("⚠️  Canonical reset is protected.");
    humanError("   Required flags:");
    humanError("   --force --apply --confirm RESET_CANONICAL");
    humanError("   Example:");
    humanError("   npm run cloud:db:reset:canonical -- --force --apply --confirm RESET_CANONICAL");
    process.exit(1);
  }

  humanLog("🧨 Resetting canonical/reference/effects data on Cloud SQL (preserving user/player/auth tables)...");

  const password = runCapture(`gcloud secrets versions access latest --secret=cloudsql-password --project ${PROJECT}`);
  const instance = gcloudJson<{ ipAddresses?: Array<{ type?: string; ipAddress?: string }> }>(
    `sql instances describe majel-pg --project ${PROJECT}`,
  );
  const publicIp = instance.ipAddresses?.find((ip) => ip.type === "PRIMARY")?.ipAddress;

  if (!publicIp) {
    humanError("❌ Could not find Cloud SQL public IP");
    process.exit(1);
  }

  const resetScript = `
import pg from "pg";

const PRESERVE_TABLES = new Set([
  "users",
  "user_sessions",
  "email_tokens",
  "invite_codes",
  "tenant_sessions",
  "auth_audit_log",
  "user_settings",
  "inventory_items",
  "officer_overlay",
  "ship_overlay",
  "targets",
  "intent_catalog",
  "bridge_cores",
  "bridge_core_members",
  "below_deck_policies",
  "loadouts",
  "loadout_variants",
  "docks",
  "fleet_presets",
  "fleet_preset_slots",
  "plan_items",
  "officer_reservations",
  "mutation_proposals",
  "behavior_rules",
  "lex_frames"
]);

const pool = new pg.Pool({
  host: ${JSON.stringify(publicIp)},
  port: 5432,
  user: "postgres",
  password: process.env.CLOUD_DB_PASSWORD,
  database: "majel",
});

try {
  const rows = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );

  const allTables = rows.rows.map((row) => String(row.tablename));
  const preserve = allTables.filter((tableName) => PRESERVE_TABLES.has(tableName));
  const truncate = allTables.filter((tableName) => !PRESERVE_TABLES.has(tableName));

  if (truncate.length > 0) {
    const quoted = truncate.map((tableName) => '"' + tableName + '"').join(", ");
    await pool.query("BEGIN");
    await pool.query("TRUNCATE TABLE " + quoted + " RESTART IDENTITY CASCADE");
    await pool.query("COMMIT");
  }

  console.log(JSON.stringify({
    preserved: preserve,
    truncated: truncate,
    preservedCount: preserve.length,
    truncatedCount: truncate.length,
  }));
} catch (error) {
  try { await pool.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  await pool.end();
}
`;

  const tmpFile = resolve(process.cwd(), ".tmp-db-reset-canonical.mts");
  writeFileSync(tmpFile, resetScript);

  const result = spawnSync("npx", ["tsx", tmpFile], {
    cwd: process.cwd(),
    env: { ...process.env, CLOUD_DB_PASSWORD: password },
    stdio: "pipe",
    encoding: "utf-8",
  });

  try { unlinkSync(tmpFile); } catch { /* ignore */ }

  let payload: {
    preserved?: string[];
    truncated?: string[];
    preservedCount?: number;
    truncatedCount?: number;
  } = {};

  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {
    payload = {};
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "Unknown canonical reset failure";
    if (AX_MODE) {
      axOutput("db:reset:canonical", start, {
        status: "failed",
        stderr,
        ...payload,
      }, { success: false, errors: [stderr] });
    } else {
      humanError("❌ Canonical reset failed");
      if (stderr) humanError(stderr);
    }
    process.exit(1);
  }

  if (AX_MODE) {
    axOutput("db:reset:canonical", start, {
      status: "completed",
      ...payload,
    });
  } else {
    const truncated = payload.truncated ?? [];
    const preserved = payload.preserved ?? [];
    humanLog("✅ Canonical reset complete");
    humanLog(`   Truncated tables: ${payload.truncatedCount ?? truncated.length}`);
    humanLog(`   Preserved tables: ${payload.preservedCount ?? preserved.length}`);
    if (truncated.length > 0) {
      humanLog(`   Truncated list: ${truncated.join(", ")}`);
    }
  }
}

export async function cmdSql(): Promise<void> {
  const start = Date.now();

  interface SqlInstance {
    state?: string;
    databaseVersion?: string;
    settings?: {
      tier?: string;
      dataDiskSizeGb?: string;
      dataDiskType?: string;
      backupConfiguration?: { enabled?: boolean; startTime?: string };
      availabilityType?: string;
    };
    ipAddresses?: Array<{ type?: string; ipAddress?: string }>;
    connectionName?: string;
    createTime?: string;
    serverCaCert?: { expirationTime?: string };
  }

  const instance = gcloudJson<SqlInstance>(`sql instances describe majel-pg --project ${PROJECT}`);

  if (AX_MODE) {
    axOutput("sql", start, {
      instance: "majel-pg",
      project: PROJECT,
      state: instance.state,
      version: instance.databaseVersion,
      tier: instance.settings?.tier,
      diskSizeGb: instance.settings?.dataDiskSizeGb,
      diskType: instance.settings?.dataDiskType,
      availability: instance.settings?.availabilityType,
      backups: instance.settings?.backupConfiguration?.enabled,
      backupWindow: instance.settings?.backupConfiguration?.startTime,
      connectionName: instance.connectionName,
      created: instance.createTime,
      ipAddresses: instance.ipAddresses,
      certExpires: instance.serverCaCert?.expirationTime,
    });
  } else {
    humanLog("\ud83d\udc18 Cloud SQL Instance");
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    humanLog(`  Instance:     majel-pg`);
    humanLog(`  State:        ${instance.state}`);
    humanLog(`  Version:      ${instance.databaseVersion}`);
    humanLog(`  Tier:         ${instance.settings?.tier}`);
    humanLog(`  Disk:         ${instance.settings?.dataDiskSizeGb} GB (${instance.settings?.dataDiskType})`);
    humanLog(`  Availability: ${instance.settings?.availabilityType}`);
    humanLog(`  Backups:      ${instance.settings?.backupConfiguration?.enabled ? "\u2705 enabled" : "\u274c disabled"} (window: ${instance.settings?.backupConfiguration?.startTime ?? "unset"})`);
    humanLog(`  Connection:   ${instance.connectionName}`);
    humanLog(`  Created:      ${instance.createTime}`);
    if (instance.ipAddresses?.length) {
      humanLog("\n  IP Addresses:");
      for (const ip of instance.ipAddresses) {
        humanLog(`    ${ip.type}: ${ip.ipAddress}`);
      }
    }
  }
}
