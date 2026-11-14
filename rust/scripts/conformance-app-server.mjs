import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`command failed (${code}): ${command} ${args.join(" ")}\n${stderr}`));
    });
  });
}

function parseJsonOutput(stdout, label) {
  const line = stdout.trim().split(/\r?\n/).filter((entry) => entry.startsWith("{")).at(-1);
  assert(line, `${label}: missing JSON output`);
  return JSON.parse(line);
}

function parseLog(logPath) {
  return fs.readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function compare(label, node, rust) {
  const nodeJson = JSON.stringify(stable(node));
  const rustJson = JSON.stringify(stable(rust));
  assert(nodeJson === rustJson, `${label}: node=${nodeJson} rust=${rustJson}`);
}

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ads-app-server-conformance-"));
  const workspace = path.join(sandbox, "workspace");
  fs.mkdirSync(workspace);
  const fixture = path.join(scriptDir, "fixtures", "fake-codex-app-server.mjs");
  const wrapper = path.join(sandbox, "fake-codex");
  const tsLog = path.join(sandbox, "ts-rpc.log");
  const rustLog = path.join(sandbox, "rust-rpc.log");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  try {
    const tsRun = await run(
      process.execPath,
      ["--import", "tsx", path.join(scriptDir, "app-server-ts-probe.ts")],
      {
        cwd: root,
        env: {
          ...process.env,
          ADS_APP_SERVER_PROBE_BIN: wrapper,
          ADS_APP_SERVER_PROBE_CWD: workspace,
          ADS_APP_SERVER_PROBE_LOG: tsLog,
          ADS_STATE_DIR: path.join(sandbox, "ts-state"),
        },
      },
    );
    const rustRun = await run(
      "cargo",
      ["run", "--quiet", "-p", "ads-codex-app-server", "--example", "agent_probe"],
      {
        cwd: rustDir,
        env: {
          ...process.env,
          ADS_APP_SERVER_PROBE_BIN: wrapper,
          ADS_APP_SERVER_PROBE_CWD: workspace,
          ADS_APP_SERVER_PROBE_LOG: rustLog,
        },
      },
    );
    const nodeResult = parseJsonOutput(tsRun.stdout, "typescript adapter");
    const rustResult = parseJsonOutput(rustRun.stdout, "rust agent");
    compare("agent result", nodeResult, rustResult);
    compare("rpc transcript", parseLog(tsLog), parseLog(rustLog));
    console.log("ok: Codex App-Server conformance");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
