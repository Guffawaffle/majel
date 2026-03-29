/**
 * runtime-profile.ts — Runtime Profile Model (ADR-050)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Defines the three-layer profile contract:
 *   1. Boot invariants — what must exist for the process to start
 *   2. Runtime capabilities — what the running process is allowed to do
 *   3. Provider mode — how the chat engine behaves
 *
 * The profile is resolved once at startup and is immutable for the process lifetime.
 */

// ─── Types ──────────────────────────────────────────────────────

export type RuntimeProfile = "dev_local" | "cloud_prod" | "test";

export type ProviderMode = "real" | "stub" | "off";

export interface BootInvariants {
  requireDatabase: boolean;
  requireProvider: boolean;
  requireAuth: boolean;
}

export interface RuntimeCapabilities {
  providerMode: ProviderMode;
  authEnforced: boolean;
  bootstrapAdmiral: boolean;
  devEndpoints: boolean;
  devInspection: boolean;
  devSeed: boolean;
  prettyLogs: boolean;
  gcpLogFormat: boolean;
  verboseTraces: boolean;
}

export interface ProfileContract {
  invariants: BootInvariants;
  capabilities: RuntimeCapabilities;
}

// ─── Profile Contracts ──────────────────────────────────────────

export const PROFILE_CONTRACTS: Record<RuntimeProfile, ProfileContract> = {
  dev_local: {
    invariants: {
      requireDatabase: true,
      requireProvider: false,
      requireAuth: false,
    },
    capabilities: {
      providerMode: "stub",
      authEnforced: false,
      bootstrapAdmiral: true,
      devEndpoints: true,
      devInspection: true,
      devSeed: true,
      prettyLogs: true,
      gcpLogFormat: false,
      verboseTraces: true,
    },
  },
  cloud_prod: {
    invariants: {
      requireDatabase: true,
      requireProvider: true,
      requireAuth: true,
    },
    capabilities: {
      providerMode: "real",
      authEnforced: true,
      bootstrapAdmiral: false,
      devEndpoints: false,
      devInspection: false,
      devSeed: false,
      prettyLogs: false,
      gcpLogFormat: true,
      verboseTraces: false,
    },
  },
  test: {
    invariants: {
      requireDatabase: false,
      requireProvider: false,
      requireAuth: false,
    },
    capabilities: {
      providerMode: "off",
      authEnforced: false,
      bootstrapAdmiral: true,
      devEndpoints: false,
      devInspection: false,
      devSeed: false,
      prettyLogs: false,
      gcpLogFormat: false,
      verboseTraces: false,
    },
  },
};

// ─── Resolution ─────────────────────────────────────────────────

/**
 * Resolve the runtime profile from environment.
 * Explicit MAJEL_PROFILE always wins; otherwise inferred from NODE_ENV / VITEST.
 */
export function resolveProfile(): RuntimeProfile {
  const explicit = process.env.MAJEL_PROFILE;
  if (explicit === "dev_local" || explicit === "cloud_prod" || explicit === "test") {
    return explicit;
  }
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return "test";
  }
  if (process.env.NODE_ENV === "production") {
    return "cloud_prod";
  }
  return "dev_local";
}

/**
 * Resolve provider mode for a profile.
 * In dev_local, MAJEL_DEV_PROVIDER overrides the default stub mode.
 */
export function resolveProviderMode(
  profile: RuntimeProfile,
  baseMode: ProviderMode,
): ProviderMode {
  if (profile !== "dev_local") return baseMode;

  const override = process.env.MAJEL_DEV_PROVIDER;
  if (override === "real" || override === "stub" || override === "off") {
    return override;
  }
  return baseMode;
}

/**
 * Get the full contract for a profile, with provider mode resolved.
 */
export function getProfileContract(profile: RuntimeProfile): ProfileContract {
  const base = PROFILE_CONTRACTS[profile];
  const providerMode = resolveProviderMode(profile, base.capabilities.providerMode);
  return {
    invariants: { ...base.invariants },
    capabilities: { ...base.capabilities, providerMode },
  };
}

// ─── Validation ─────────────────────────────────────────────────

/**
 * Validate profile invariants against the current environment.
 * Throws on failure — fail fast, fail loud.
 */
export function validateProfile(
  profile: RuntimeProfile,
  contract: ProfileContract,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const errors: string[] = [];

  if (contract.invariants.requireDatabase) {
    if (profile === "cloud_prod" && !env.DATABASE_URL) {
      errors.push("DATABASE_URL must be set in cloud_prod profile");
    }
  }

  if (contract.invariants.requireProvider && !env.GEMINI_API_KEY) {
    errors.push("GEMINI_API_KEY must be set in cloud_prod profile");
  }

  if (contract.invariants.requireAuth && !env.MAJEL_ADMIN_TOKEN && !env.MAJEL_INVITE_SECRET) {
    errors.push("MAJEL_ADMIN_TOKEN or MAJEL_INVITE_SECRET must be set when auth is required");
  }

  if (profile === "cloud_prod" && contract.capabilities.devEndpoints) {
    errors.push("FATAL: devEndpoints capability is true in cloud_prod — this is a configuration error");
  }

  if (profile === "cloud_prod" && contract.capabilities.bootstrapAdmiral) {
    errors.push("FATAL: bootstrapAdmiral capability is true in cloud_prod — auth bypass must not be enabled in production");
  }

  if (env.MAJEL_PROFILE === "dev_local" && env.NODE_ENV === "production") {
    errors.push("MAJEL_PROFILE=dev_local conflicts with NODE_ENV=production");
  }

  if (errors.length > 0) {
    const msg = `\n❌ Profile validation failed [${profile}]:\n${errors.map(e => `  • ${e}`).join("\n")}\n`;
    throw new Error(msg);
  }
}

// ─── Boot Banner ────────────────────────────────────────────────

/**
 * Print a clear boot banner showing the active profile and key capabilities.
 */
export function printBootBanner(
  profile: RuntimeProfile,
  contract: ProfileContract,
  databaseUrl: string,
): void {
  const { capabilities } = contract;
  const providerLabel = capabilities.providerMode === "stub"
    ? "stub (MAJEL_DEV_PROVIDER=real for live)"
    : capabilities.providerMode;
  const authLabel = capabilities.authEnforced
    ? "enforced"
    : "disabled (admiral bypass)";
  const devLabel = capabilities.devEndpoints
    ? "enabled (/api/dev/*)"
    : "disabled";
  // Redact credentials from the URL for display
  const safeUrl = databaseUrl.replace(/\/\/.*@/, "//<redacted>@");

  const lines = [
    `┌─────────────────────────────────────────────────────┐`,
    `│  MAJEL  ${profile.padEnd(43)}│`,
    `│  Provider: ${providerLabel.padEnd(40)}│`,
    `│  Auth: ${authLabel.padEnd(44)}│`,
    `│  Dev endpoints: ${devLabel.padEnd(35)}│`,
    `│  Database: ${safeUrl.padEnd(40)}│`,
    `└─────────────────────────────────────────────────────┘`,
  ];

  // Use console.log for the banner — logger may not be ready yet
  for (const line of lines) {
    console.log(line);
  }
}
