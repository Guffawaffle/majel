/**
 * ax/status.ts — Project health: git, postgres, server, tests.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { ROOT, runCapture, makeResult } from "./runner.js";

const command: AxCommand = {
  name: "status",
  description: "Project health: git, postgres, server, tests",

  async run(_args): Promise<AxResult> {
    const start = Date.now();

    // Git
    const branch = runCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], { ignoreExit: true });
    const sha = runCapture("git", ["rev-parse", "--short", "HEAD"], { ignoreExit: true });
    const dirty = runCapture("git", ["status", "--porcelain"], { ignoreExit: true });
    const dirtyFiles = dirty.stdout.trim().split("\n").filter(Boolean);
    const ahead = runCapture("git", ["rev-list", "--count", "HEAD", "--not", "origin/main"], { ignoreExit: true });

    // Package version
    let version = "unknown";
    try {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
      version = pkg.version;
    } catch { /* */ }

    // Postgres
    const pg = runCapture("docker", ["exec", "majel-postgres-1", "pg_isready", "-U", "majel", "-q"], { ignoreExit: true });
    const pgUp = pg.exitCode === 0;

    // Dev server
    const port = process.env.MAJEL_PORT ?? "3000";
    const health = runCapture("curl", ["-sf", `http://localhost:${port}/api/health`], { ignoreExit: true });
    let serverUp = false;
    let serverStatus: Record<string, unknown> = {};
    if (health.exitCode === 0) {
      try {
        serverStatus = JSON.parse(health.stdout);
        serverUp = true;
      } catch { /* */ }
    }

    // Test files
    const testFiles = runCapture("find", ["test", "-name", "*.test.ts", "-type", "f"], { ignoreExit: true });
    const testFileCount = testFiles.stdout.trim().split("\n").filter(Boolean).length;

    return makeResult("status", start, {
      version,
      git: {
        branch: branch.stdout.trim(),
        sha: sha.stdout.trim(),
        dirty: dirtyFiles.length,
        dirtyFiles: dirtyFiles.slice(0, 20),
        aheadOfMain: Number(ahead.stdout.trim()) || 0,
      },
      postgres: pgUp,
      server: {
        running: serverUp,
        port,
        ...serverStatus,
      },
      testFiles: testFileCount,
    });
  },
};

export default command;
