import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// 1. Bundle server code into a single file
console.log("[bundle] Bundling server code with esbuild...");
await esbuild.build({
  entryPoints: [path.join(DIST, "server", "cli.js")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(DIST, "server", "cli.bundle.js"),
  external: ["better-sqlite3"],
  sourcemap: true,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

// 2. Remove old individual files, keep only bundle
console.log("[bundle] Cleaning up individual server files...");
const serverDir = path.join(DIST, "server");
function removeOldFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else if (entry.name !== "cli.bundle.js" && entry.name !== "cli.bundle.js.map") {
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
if (fs.existsSync(path.join(serverDir, "cli.bundle.js.map"))) {
  fs.renameSync(
    path.join(serverDir, "cli.bundle.js.map"),
    path.join(serverDir, "cli.js.map"),
  );
}
console.log("[bundle] Server bundled into dist/server/cli.js");

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

// 4. Clean up dist/package.json - make it minimal for runtime
const distPkg = {
  name: "ads",
  version: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
  type: "module",
  scripts: {
    start: "node server/cli.js web",
  },
  engines: {
    node: ">=20",
  },
};
fs.writeFileSync(
  path.join(DIST, "package.json"),
  JSON.stringify(distPkg, null, 2) + "\n",
);

// 5. Remove .ads directory and db files from dist (user workspace data)
for (const f of [".ads", "ads.db", "ads.db-shm", "ads.db-wal"]) {
  const p = path.join(DIST, f);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

console.log("[bundle] Done! dist/ is now self-contained.");
console.log("[bundle] To deploy: copy dist/ to target machine and run:");
console.log("[bundle]   cd dist && node server/cli.js web");
