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
      "/litellm-web": "http://localhost:3000",
    },
  },
});
