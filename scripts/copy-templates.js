import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

function initScriptLogger() {
  const original = {
    log: console.log.bind(console),
    info: console.info ? console.info.bind(console) : console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const logDir = path.join(ROOT_DIR, ".ads", "logs");
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (error) {
    original.warn("[copy-templates] Failed to prepare log directory", error);
    return;
  }

  let stream;
  try {
    stream = fs.createWriteStream(path.join(logDir, "build.log"), { flags: "a" });
  } catch (error) {
    original.warn("[copy-templates] Failed to open log file", error);
    return;
  }

  const write = (level, mirror) => (...args) => {
    const timestamp = new Date().toISOString();
    const text = args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    stream.write(`${timestamp} ${level} ${text}\n`);
    mirror(...args);
  };

  console.log = write("INFO", original.log);
  console.info = write("INFO", original.info);
  console.warn = write("WARN", original.warn);
  console.error = write("ERROR", original.error);

  const close = () => {
    if (stream) {
      stream.end();
    }
  };
  process.once("exit", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

initScriptLogger();
const SRC_DIR = path.join(ROOT_DIR, "templates");
const DEST_DIR = path.join(ROOT_DIR, "dist", "templates");
const GRAPH_CONFIG_SRC = path.join(ROOT_DIR, "src", "graph", "config.yaml");
const GRAPH_CONFIG_DEST_DIR = path.join(ROOT_DIR, "dist", "src", "graph");

if (!fs.existsSync(path.join(ROOT_DIR, "dist"))) {
  fs.mkdirSync(path.join(ROOT_DIR, "dist"), { recursive: true });
}

if (!fs.existsSync(SRC_DIR)) {
  console.warn(`[copy-templates] Source templates not found at ${SRC_DIR}`);
  process.exit(0);
}

const entries = fs.readdirSync(SRC_DIR, { withFileTypes: true });
const requiredFiles = new Set([
  "instructions.md",
  "rules.md",
  "supervisor.md",
  "requirement.md",
  "design.md",
  "implementation.md",
  "workflow.yaml",
]);
const unexpectedDirs = entries.filter((entry) => entry.isDirectory());
if (unexpectedDirs.length > 0) {
  console.warn(
    `[copy-templates] Unexpected subdirectories in templates/: ${unexpectedDirs
      .map((entry) => entry.name)
      .join(", ")}. Only files will be copied.`,
  );
}

fs.rmSync(DEST_DIR, { recursive: true, force: true });
fs.mkdirSync(DEST_DIR, { recursive: true });

const missingFiles = Array.from(requiredFiles).filter(
  (file) => !entries.some((entry) => entry.isFile() && entry.name === file),
);
if (missingFiles.length > 0) {
  console.error(`[copy-templates] Missing required template files: ${missingFiles.join(", ")}`);
  process.exit(1);
}

for (const entry of entries) {
  if (!entry.isFile()) {
    continue;
  }
  const srcPath = path.join(SRC_DIR, entry.name);
  const destPath = path.join(DEST_DIR, entry.name);
  fs.copyFileSync(srcPath, destPath);
}

console.log(`[copy-templates] Templates copied to ${DEST_DIR}`);

// Also ensure workflow graph config is available in dist for runtime
try {
  if (fs.existsSync(GRAPH_CONFIG_SRC)) {
    fs.mkdirSync(GRAPH_CONFIG_DEST_DIR, { recursive: true });
    const graphConfigDest = path.join(GRAPH_CONFIG_DEST_DIR, "config.yaml");
    fs.copyFileSync(GRAPH_CONFIG_SRC, graphConfigDest);
    console.log(`[copy-templates] Graph config copied to ${graphConfigDest}`);
  } else {
    console.warn(`[copy-templates] Graph config not found at ${GRAPH_CONFIG_SRC}`);
  }
} catch (error) {
  console.warn(`[copy-templates] Failed to copy graph config: ${(error ?? {}).message ?? error}`);
}
