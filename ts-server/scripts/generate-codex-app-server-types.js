#!/usr/bin/env node
/**
 * Generate TypeScript bindings for the Codex app-server JSON-RPC protocol.
 *
 * Codex emits files via `codex app-server generate-ts --out <dir>`. The
 * generator uses ts-rs which writes imports without file extensions, which is
 * incompatible with our NodeNext module resolution. After generation we
 * post-process the files to:
 *   - Add `.js` extensions to relative imports.
 *   - Stamp every file with an ADS-specific header noting that files are
 *     generated and must not be edited by hand.
 *
 * Run with `npm run codex:regen-types` whenever the upstream protocol changes.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT_DIR, "server", "codex", "appServer", "protocol");
const BINARY = process.env.ADS_CODEX_BIN || "codex";

function ensureFreshOutDir() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function runCodexGenerator() {
  console.log(`[codex-types] running: ${BINARY} app-server generate-ts --out ${OUT_DIR} --experimental`);
  try {
    execFileSync(BINARY, ["app-server", "generate-ts", "--out", OUT_DIR, "--experimental"], {
      stdio: "inherit",
    });
  } catch (err) {
    console.error(`[codex-types] failed to run ${BINARY}:`, err.message);
    process.exit(1);
  }
}

const ADS_HEADER = [
  "// ADS-GENERATED FILE — DO NOT EDIT BY HAND.",
  "// Regenerate via `npm run codex:regen-types` (requires `codex` CLI on PATH).",
  "// Source: `codex app-server generate-ts`.",
  "",
].join("\n");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

function rewriteImports(source, currentFile) {
  const currentDir = path.dirname(currentFile);
  return source.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g,
    (match, prefix, target, suffix) => {
      if (target.endsWith(".js") || target.endsWith(".ts")) {
        return match;
      }
      const resolved = path.resolve(currentDir, target);
      let candidate = `${target}.js`;
      try {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          candidate = `${target}/index.js`;
        }
      } catch {
        // Not a directory; default candidate already appends `.js`.
      }
      return `${prefix}${candidate}${suffix}`;
    },
  );
}

function stampFiles() {
  let count = 0;
  for (const file of walk(OUT_DIR)) {
    const original = fs.readFileSync(file, "utf8");
    const rewritten = rewriteImports(original, file);
    const next = `${ADS_HEADER}${rewritten}`;
    fs.writeFileSync(file, next, "utf8");
    count += 1;
  }
  console.log(`[codex-types] stamped ${count} files under ${path.relative(ROOT_DIR, OUT_DIR)}`);
}

function writeReadme() {
  const readme = [
    "# Codex App-Server Protocol Bindings",
    "",
    "Generated TypeScript bindings emitted by `codex app-server generate-ts`.",
    "",
    "- DO NOT edit files in this directory by hand.",
    "- Regenerate with `npm run codex:regen-types` after updating the `codex` CLI.",
    "- Imports are post-processed to add `.js` extensions so they compile under NodeNext.",
    "- These are type-only artifacts; the runtime client lives in `../rpcClient.ts`.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme, "utf8");
}

ensureFreshOutDir();
runCodexGenerator();
stampFiles();
writeReadme();
console.log("[codex-types] done.");
