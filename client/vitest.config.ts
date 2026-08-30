import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");
const frontendMaxWorkers =
  process.env.ADS_VITEST_MAX_WORKERS?.trim() ||
  process.env.VITEST_MAX_WORKERS?.trim() ||
  "2";

export default defineConfig({
  root: webRoot,
  cacheDir: path.resolve(repoRoot, "node_modules", ".vite", "client-vitest"),
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify("0.0.1"),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
    maxWorkers: frontendMaxWorkers,
    restoreMocks: true,
    clearMocks: true,
  },
});
