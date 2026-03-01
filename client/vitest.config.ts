import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");

export default defineConfig({
  root: webRoot,
  cacheDir: path.resolve(repoRoot, "node_modules", ".vite", "client-vitest"),
  plugins: [vue()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
    restoreMocks: true,
    clearMocks: true,
  },
});
