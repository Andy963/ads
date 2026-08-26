import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

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
    cacheDir: path.resolve(repoRoot, "node_modules", ".vite", "client"),
    base,
    plugins: [
      vue(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: false,
        includeAssets: ["favicon.ico", "apple-touch-icon.png", "pwa-192x192.png", "pwa-512x512.png"],
        manifest: {
          id: base,
          name: "ADS Tasks",
          short_name: "ADS",
          description: "ADS Task & Agent Management",
          theme_color: "#18181b",
          background_color: "#09090b",
          display: "standalone",
          orientation: "portrait",
          start_url: base,
          scope: base,
          icons: [
            {
              src: "pwa-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
            },
            {
              src: "pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any maskable",
            },
          ],
        },
        workbox: {
          navigateFallbackDenylist: [/^\/api/, /^\/ws/],
          globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        },
      }),
    ],
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
      outDir: path.resolve(repoRoot, "dist", "client"),
      emptyOutDir: true,
    },
  };
});
