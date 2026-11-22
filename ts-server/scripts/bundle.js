import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const SERVER_DIST = DIST;

// 1. Bundle server code into a single file
console.log("[bundle] Bundling server code with esbuild...");
await esbuild.build({
  entryPoints: [path.join(SERVER_DIST, "server", "cli.js")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(SERVER_DIST, "server", "cli.bundle.js"),
  external: ["better-sqlite3"],
  sourcemap: false,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

// 2. Remove old individual files, keep only bundle
console.log("[bundle] Cleaning up individual server files...");
const serverDir = path.join(SERVER_DIST, "server");
function removeOldFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else if (entry.name !== "cli.bundle.js") {
      fs.unlinkSync(fullPath);
    }
  }
}
removeOldFiles(serverDir);

// Rename bundle to cli.js
fs.renameSync(
  path.join(serverDir, "cli.bundle.js"),
  path.join(serverDir, "cli.js"),
);
console.log("[bundle] Server bundled into ts-server/dist/server/cli.js");

// 3. Copy better-sqlite3 native module (with its dependencies)
console.log("[bundle] Copying better-sqlite3 native module...");
const distNodeModules = path.join(DIST, "node_modules");
fs.mkdirSync(distNodeModules, { recursive: true });

const nativeModules = ["better-sqlite3", "bindings", "file-uri-to-path"];
for (const mod of nativeModules) {
  const src = path.join(ROOT, "node_modules", mod);
  const dest = path.join(distNodeModules, mod);
  if (!fs.existsSync(src)) {
    console.warn(`[bundle] Warning: ${mod} not found in node_modules, skipping`);
    continue;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      // Skip source code and build deps (only needed at compile time)
      if (rel.startsWith("src") || rel.startsWith("deps")) return false;
      return true;
    },
  });
  console.log(`[bundle]   ✓ ${mod}`);
}

// 4. Remove package metadata and user workspace data from dist.
for (const f of ["package.json", ".ads", "ads.db", "ads.db-shm", "ads.db-wal"]) {
  const p = path.join(DIST, f);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

console.log("[bundle] Done! ts-server/dist/ is now self-contained.");
console.log("[bundle] To deploy: copy client/dist and ts-server/dist to the target machine and run:");
console.log("[bundle]   cd ts-server && node dist/server/cli.js");
