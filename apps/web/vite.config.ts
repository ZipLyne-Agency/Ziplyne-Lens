import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The product version lives in the monorepo root package.json (the API and
// web packages carry their own internal versions, which mean nothing to users).
const productVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(productVersion),
  },
  server: {
    host: "127.0.0.1",
    port: Number.parseInt(process.env.PORT ?? "5173", 10),
    proxy: {
      "/api": {
        target: process.env.ZIPLYNE_API_URL ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
