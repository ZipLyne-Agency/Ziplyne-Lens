import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@ziplyne/core": resolve(import.meta.dirname, "../../packages/core/src"),
    },
  },
});
