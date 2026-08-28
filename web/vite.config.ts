import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Dev: Vite serves on :5173; API requests are proxied to the Node backend on :3000.
// WebSocket URL is chosen by the client at runtime (see src/hooks/useWebSocket.ts) —
// in dev it connects directly to ws://localhost:3000/, avoiding a proxy that would
// collide with the SPA's own root path.
//
// Prod: `vite build` emits to `dist/`. server.js serves that at `/` (the React SPA
// is the sole frontend). `base: "/"` makes asset URLs `/assets/...`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // E2E-only test seam (window.__chatStore): set VITE_E2E_SEAM=1 for the
  // Playwright dist build; release/prod builds never set it.
  define: {
    "import.meta.env.VITE_E2E_SEAM": JSON.stringify(process.env.VITE_E2E_SEAM ?? "0"),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/oc-web": "http://localhost:3000",
      "/external": "http://localhost:3000",
      "/ui": "http://localhost:3000",
      "/key": "http://localhost:3000",
      "/spend": "http://localhost:3000",
      "/model": "http://localhost:3000",
      "/models": "http://localhost:3000",
      "/user": "http://localhost:3000",
      "/get_image": "http://localhost:3000",
      "/get_favicon": "http://localhost:3000",
      "/get": "http://localhost:3000",
      "/v2": "http://localhost:3000",
      "/sso": "http://localhost:3000",
      "/login": "http://localhost:3000",
      "/logout": "http://localhost:3000",
      // OpenConnector web UI assets/API (both use root-level paths).
      // In dev Vite doesn't own /assets/ (that's a build output concept),
      // so these forward cleanly to the backend proxy.
      "/assets": "http://localhost:3000",
      "/v1": "http://localhost:3000",
    },
  },
});
