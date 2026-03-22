/**
 * ax/dev-reset.ts — Truncate user-scoped tables, preserve catalog (ADR-050)
 *
 * Calls the running dev server's /api/dev/reset endpoint.
 * Requires the dev server to be running with dev_local profile.
 */

import type { AxCommand, AxResult } from "./types.js";
import { makeResult, runCapture } from "./runner.js";

const command: AxCommand = {
  name: "dev:reset",
  description: "Truncate user-scoped tables, preserve reference catalog",

  async run(_args): Promise<AxResult> {
    const start = Date.now();
    const port = process.env.MAJEL_PORT ?? "3000";
    const url = `http://localhost:${port}/api/dev/reset`;

    const result = runCapture("curl", ["-sf", "-X", "POST", "-H", "X-Requested-With: majel-client", url], { ignoreExit: true });

    if (result.exitCode !== 0) {
      return makeResult("dev:reset", start, {
        endpoint: url,
        exitCode: result.exitCode,
      }, {
        success: false,
        errors: ["Dev server not reachable or dev endpoints not enabled"],
        hints: [
          "Start server with: npm run dev",
          "Dev endpoints require dev_local profile (default for local dev)",
        ],
      });
    }

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(result.stdout);
    } catch { /* best-effort */ }

    return makeResult("dev:reset", start, {
      endpoint: url,
      response: body,
    });
  },
};

export default command;
