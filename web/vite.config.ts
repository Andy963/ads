import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeBasePath(raw: string | undefined): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, "..");
  const env = loadEnv(mode, repoRoot, "");
  const base = normalizeBasePath(env.ADS_WEB_BASE_PATH || env.VITE_BASE_PATH);

  return {
    root: __dirname,
    base,
    plugins: [vue()],
    server: {
      proxy: {
        "/api": {
          target: "http://localhost:8787",
          changeOrigin: true,
        },
        "/ws": {
          target: "ws://localhost:8787",
          ws: true,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: path.resolve(repoRoot, "dist", "web"),
      emptyOutDir: true,
    },
  };
});
