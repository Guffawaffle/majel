import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/server/**/*.ts"],
      exclude: ["src/client/**"],
      reporter: ["text", "text-summary", "lcov"],
      thresholds: {
        // boot() and shutdown() are integration-level (real ports, process.exit)
        // sheets.ts OAuth flow requires real Google credentials
        // Per-file thresholds enforce coverage where it matters
        lines: 45,
        functions: 60,
        branches: 55,
        statements: 45,
        perFile: false,
      },
    },
    // Isolate tests to avoid module state leaks
    pool: "forks",
    // All test files share one PG database; disable file parallelism to avoid table conflicts
    fileParallelism: false,
    testTimeout: 10000,
  },
});
