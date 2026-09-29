#!/usr/bin/env node
// Reproducible web-bundle size report (issue #459).
//
// Builds the client (unless --skip-build) and reports, for the emitted
// dist/client: per-chunk minified and gzip sizes, the initial-load JavaScript
// set (entry script plus modulepreload links referenced by index.html), total
// application JavaScript, request counts, and build wall time.
//
// Usage:
//   node scripts/report-web-bundle.js [--skip-build] [--fixture] [--json]
//
// --fixture builds with ADS_WEB_FIXTURE_ENTRY=1 so the report also covers the
// optional fixture entry.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist", "client");
const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const fixture = args.includes("--fixture");
const asJson = args.includes("--json");

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

let buildMs = null;
if (!skipBuild) {
  const started = Date.now();
  execFileSync("npx", ["vite", "build", "--config", "client/vite.config.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...(fixture ? { ADS_WEB_FIXTURE_ENTRY: "1" } : {}) },
  });
  buildMs = Date.now() - started;
}

const indexHtmlPath = path.join(distDir, "index.html");
if (!fs.existsSync(indexHtmlPath)) {
  console.error(`dist/client/index.html not found at ${indexHtmlPath}; run without --skip-build first.`);
  process.exit(1);
}
const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");

// Initial-load requests: the module script plus modulepreload/stylesheet links.
const initialAssets = new Set();
for (const match of indexHtml.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)) initialAssets.add(match[1]);
for (const match of indexHtml.matchAll(/<script[^>]+src="([^"]+)"[^>]*type="module"/g)) initialAssets.add(match[1]);
for (const match of indexHtml.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) initialAssets.add(match[1]);
for (const match of indexHtml.matchAll(/<link[^>]+href="([^"]+)"[^>]+rel="modulepreload"/g)) initialAssets.add(match[1]);
for (const match of indexHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) initialAssets.add(match[1]);

function statAsset(rel) {
  const abs = path.join(distDir, rel);
  if (!fs.existsSync(abs)) return null;
  const content = fs.readFileSync(abs);
  return { file: rel, bytes: content.length, gzipBytes: zlib.gzipSync(content, { level: 9 }).length };
}

const allJs = fs
  .readdirSync(path.join(distDir, "assets"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => statAsset(path.join("assets", name)))
  .filter(Boolean)
  .sort((a, b) => b.bytes - a.bytes);

const initialJs = allJs.filter((asset) => initialAssets.has(`/${asset.file}`) || initialAssets.has(asset.file));
const sum = (list, key) => list.reduce((total, item) => total + item[key], 0);

const htmlEntries = fs.readdirSync(distDir).filter((name) => name.endsWith(".html")).sort();
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const viteVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "node_modules", "vite", "package.json"), "utf8")).version;

const report = {
  commit: gitCommit(),
  node: process.version,
  vite: viteVersion,
  appVersion: pkg.version,
  fixtureEntry: fixture,
  buildMs,
  htmlEntries,
  chunks: allJs,
  totals: {
    jsCount: allJs.length,
    jsBytes: sum(allJs, "bytes"),
    jsGzipBytes: sum(allJs, "gzipBytes"),
    initialJsCount: initialJs.length,
    initialJsBytes: sum(initialJs, "bytes"),
    initialJsGzipBytes: sum(initialJs, "gzipBytes"),
    initialRequests: initialAssets.size,
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`commit: ${report.commit}`);
  console.log(`node: ${report.node}  vite: ${report.vite}  app: ${report.appVersion}  fixture entry: ${fixture}`);
  if (buildMs !== null) console.log(`build wall time: ${(buildMs / 1000).toFixed(1)}s`);
  console.log(`html entries: ${htmlEntries.join(", ")}`);
  console.log("");
  console.log("chunks (minified / gzip):");
  for (const chunk of allJs) {
    const initial = initialJs.includes(chunk) ? " [initial]" : "";
    console.log(`  ${formatKb(chunk.bytes).padStart(10)} / ${formatKb(chunk.gzipBytes).padStart(9)}  ${chunk.file}${initial}`);
  }
  console.log("");
  console.log(`total application JS:   ${allJs.length} chunks, ${formatKb(report.totals.jsBytes)} min, ${formatKb(report.totals.jsGzipBytes)} gzip`);
  console.log(`initial-load JS:        ${initialJs.length} chunks, ${formatKb(report.totals.initialJsBytes)} min, ${formatKb(report.totals.initialJsGzipBytes)} gzip`);
  console.log(`initial-load requests:  ${report.totals.initialRequests} (module script + modulepreload + stylesheet)`);
}
