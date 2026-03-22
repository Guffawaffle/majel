/**
 * ax/dev-boot.ts — Validate runtime profile, check Postgres, report capabilities (ADR-050)
 */

import type { AxCommand, AxResult } from "./types.js";
import { makeResult, runCapture } from "./runner.js";

const command: AxCommand = {
  name: "dev:boot",
  description: "Validate profile, check Postgres, report capability summary",

  async run(_args): Promise<AxResult> {
    const start = Date.now();

    // Import profile resolution (using dynamic import for tsx compatibility)
    const { resolveProfile, getProfileContract, validateProfile } = await import(
      "../../src/server/runtime-profile.js"
    );

    const profile = resolveProfile();
    const contract = getProfileContract(profile);

    // Validate — throws on failure
    const errors: string[] = [];
    try {
      validateProfile(profile, contract);
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // Check Postgres
    const pg = runCapture("docker", ["exec", "majel-postgres-1", "pg_isready", "-U", "majel", "-q"], { ignoreExit: true });
    const pgUp = pg.exitCode === 0;

    if (contract.invariants.requireDatabase && !pgUp) {
      errors.push("Postgres is not running — required for this profile. Run: npm run pg");
    }

    // Check provider key availability
    const hasApiKey = !!process.env.GEMINI_API_KEY;
    const providerMode = contract.capabilities.providerMode;

    return makeResult("dev:boot", start, {
      profile,
      providerMode,
      postgres: pgUp,
      hasApiKey,
      invariants: contract.invariants,
      capabilities: contract.capabilities,
    }, {
      success: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      hints: !pgUp ? ["Run: npm run pg"] : undefined,
    });
  },
};

export default command;
