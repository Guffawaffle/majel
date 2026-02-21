import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Clear auth/secret env vars so tests run in deterministic "dev mode" (auth disabled).
    // Tests that need auth explicitly set config overrides.
    env: {
      MAJEL_ADMIN_TOKEN: "",
      MAJEL_INVITE_SECRET: "",
      MAJEL_ALLOWED_IPS: "",
      GEMINI_API_KEY: "",
    },
    coverage: {
      provider: "v8",
      include: ["src/server/**/*.ts"],
      reporter: ["text", "text-summary", "lcov"],
      thresholds: {
        // boot() and shutdown() are integration-level (real ports, process.exit)
        // sheets.ts OAuth flow requires real Google credentials
        // Per-file thresholds enforce coverage where it matters
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
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
