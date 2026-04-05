/**
 * vitest.layer-b.config.ts
 *
 * Separate Vitest configuration for Layer B prompt regression tests.
 *
 * Layer B requires a real GEMINI_API_KEY and makes live Gemini API calls.
 * It is NOT included in the standard `ax ci` pipeline — Layer B is a
 * developer-run smoke test executed with `npm run test:layer-b`.
 *
 * Unlike vitest.config.ts, this config does NOT clear GEMINI_API_KEY
 * so the runner can make real model calls.
 *
 * Layer B integration into CI comes in E6 (full regression suite).
 */
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Load .env so GEMINI_API_KEY is available without manual export.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    test: {
      globals: true,
      environment: "node",
      include: ["test/prompt-regression/layer-b.test.ts"],
      env: {
        MAJEL_ADMIN_TOKEN: "",
        MAJEL_INVITE_SECRET: "",
        MAJEL_ALLOWED_IPS: "",
        // Pull the real key from .env (falls back to empty if not present)
        GEMINI_API_KEY: env.GEMINI_API_KEY ?? "",
      },
      pool: "forks",
      fileParallelism: false,
      testTimeout: 60000,
    },
  };
});
