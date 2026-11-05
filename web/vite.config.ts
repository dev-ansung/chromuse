import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // The LangGraph dev server (server/, `pnpm dev`) listens on 2024; the app reaches it through same-origin /api.
  // "localhost", not 127.0.0.1: the dev server may bind IPv6 loopback only (::1).
  server: {
    proxy: {
      "/api": { target: "http://localhost:2024", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
