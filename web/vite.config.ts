import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * Vite plugin: redirect bare "/" to "/app/" in dev so the landing-page
 * proxy doesn't collide with Vite's own middleware.
 * In production Express handles "/" → landing.html natively.
 */
function appRedirects(): Plugin {
  return {
    name: "app-redirects",
    configureServer(server) {
      // Runs before Vite's internal middleware
      server.middlewares.use((req, res, next) => {
        // Bare "/" → go to app
        if (req.url === "/" || req.url === "/?") {
          res.writeHead(302, { Location: "/app/" });
          res.end();
          return;
        }
        // "/app" without trailing slash → add it (Vite requires it for base)
        if (req.url === "/app") {
          res.writeHead(302, { Location: "/app/" });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

const EXPRESS = "http://localhost:3000";

export default defineConfig({
  // All assets served under /app/ — matches Express mount point
  base: "/app/",

  plugins: [appRedirects(), svelte()],

  server: {
    port: 5173,
    proxy: {
      // ── API calls ──────────────────────────────────────────
      "/api": { target: EXPRESS, changeOrigin: true },
      // ── Auth / landing page routes (proxied to Express) ────
      "/login": { target: EXPRESS, changeOrigin: true },
      "/signup": { target: EXPRESS, changeOrigin: true },
      "/verify": { target: EXPRESS, changeOrigin: true },
      "/reset-password": { target: EXPRESS, changeOrigin: true },
      "/landing.css": { target: EXPRESS, changeOrigin: true },
      "/landing.js": { target: EXPRESS, changeOrigin: true },
      // ── Static assets ──────────────────────────────────────
      "/favicon.ico": { target: EXPRESS, changeOrigin: true },
      "/site.webmanifest": { target: EXPRESS, changeOrigin: true },
      "/apple-touch-icon.png": { target: EXPRESS, changeOrigin: true },
      "/ariadne-32x32.png": { target: EXPRESS, changeOrigin: true },
      "/ariadne-16x16.png": { target: EXPRESS, changeOrigin: true },
    },
  },

  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
