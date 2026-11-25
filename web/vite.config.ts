import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7070",
        changeOrigin: true,
        timeout: 0,
      },
      "/healthz": "http://127.0.0.1:7070",
      "/readyz": "http://127.0.0.1:7070",
      "/openapi.json": "http://127.0.0.1:7070",
      "/docs": "http://127.0.0.1:7070",
    },
  },
});
