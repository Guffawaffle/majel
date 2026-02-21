import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    // Svelte 5 rune files (.svelte.ts) need the Svelte compiler
    alias: {
      // Ensure .svelte.ts files are processed by the Svelte plugin
    },
  },
});
