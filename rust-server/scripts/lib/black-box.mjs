/**
 * Shared helpers for black-box conformance runs: start the TypeScript and Rust
 * servers side by side with isolated state directories, then compare their
 * observable HTTP behavior.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { tsxLoader } from "./ts-server-dependencies.mjs";

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]),
    );
  }
  return false;
}

export function assertJson(actual, expected, label) {
  assert(
    deepEqual(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

export async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startChild(command, args, options, children) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  children.push(child);
  return {
    child,
    output: () => output,
  };
}

function resolveLegacyModule(root, relativePath) {
  const source = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(root, "ts-server", relativePath);
  if (fs.existsSync(source)) {
    return source;
  }
  const built = path.join(root, "ts-server", "dist", relativePath.replace(/\.ts$/, ".js"));
  assert(fs.existsSync(built), `legacy module is unavailable: ${relativePath}`);
  return built;
}

function nodeModuleArgs(modulePath) {
  return modulePath.endsWith(".ts") ? ["--import", tsxLoader] : [];
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function waitForServer(baseUrl, handle) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (handle.child.exitCode !== null) {
      throw new Error(`server exited before becoming ready:\n${handle.output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become ready:\n${handle.output()}`);
}

export async function request(baseUrl, pathname, options = {}) {
  const requestOptions = { ...options };
  const method = String(options.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const headers = new Headers(options.headers);
    if (!headers.has("origin")) {
      headers.set("origin", baseUrl);
    }
    requestOptions.headers = headers;
  }
  const response = await fetch(`${baseUrl}${pathname}`, requestOptions);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
  };
}

export function cookiePair(setCookie) {
  return String(setCookie ?? "").split(";")[0].trim();
}

export function cookieAttributes(setCookie) {
  return String(setCookie ?? "")
    .split(";")
    .slice(1)
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

function setPath(target, dottedPath, value) {
  const segments = dottedPath.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object") return;
    cursor = cursor[segment];
  }
  const last = segments.at(-1);
  if (cursor && typeof cursor === "object" && last in cursor) {
    cursor[last] = value;
  }
}

function maskKeysRecursively(value, keys) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) maskKeysRecursively(item, keys);
    return value;
  }
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key)) {
      value[key] = "<masked>";
    } else {
      maskKeysRecursively(child, keys);
    }
  }
  return value;
}

function normalize(value, masks, maskKeys) {
  const clone = JSON.parse(JSON.stringify(value ?? null));
  for (const mask of masks) {
    setPath(clone, mask, "<masked>");
  }
  maskKeysRecursively(clone, maskKeys);
  return clone;
}

export async function compare(label, nodeResult, rustResult, options = {}) {
  const masks = options.masks ?? [];
  const maskKeys = options.maskKeys ?? [];
  assert(
    nodeResult.status === rustResult.status,
    `${label}: status ${nodeResult.status} != ${rustResult.status}`,
  );
  assertJson(
    normalize(rustResult.body, masks, maskKeys),
    normalize(nodeResult.body, masks, maskKeys),
    label,
  );
}

export async function loginAs(baseUrl, username, password) {
  const result = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username, password }),
  });
  assert(
    result.status === 200,
    `login failed with ${result.status}: ${JSON.stringify(result.body)}`,
  );
  const setCookie = result.headers.get("set-cookie");
  assert(setCookie, "login did not set a session cookie");
  return { result, cookie: cookiePair(setCookie), setCookie };
}

/**
 * Build the Rust server, initialize an admin in both stacks, and start both
 * servers with isolated state directories.
 */
export async function startServerPair(options) {
  const { root, rustDir } = options;
  const nodeEntry = resolveLegacyModule(root, options.nodeEntry ?? "server/web/server_impl.ts");
  const nodeInitAdmin = resolveLegacyModule(root, "server/web/auth/initAdminCli.ts");
  const children = [];
  const nodeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-node-conformance-"));
  const rustStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-rust-conformance-"));
  const username = options.username ?? "admin";
  const password = options.password ?? "secret";

  const cargoBinary =
    process.env.CARGO ?? path.join(os.homedir(), ".cargo", "bin", "cargo");
  const build = spawnSync(cargoBinary, ["build", "-q", "-p", "ads-server"], {
    cwd: rustDir,
    env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" },
    encoding: "utf8",
  });
  if (build.status !== 0) {
    throw new Error(
      `cargo build failed (${build.error ?? "nonzero exit"}):\n${build.stdout ?? ""}\n${build.stderr ?? ""}`,
    );
  }

  const nodeAdmin = spawnSync(
    process.execPath,
    [
      ...nodeModuleArgs(nodeInitAdmin),
      nodeInitAdmin,
      "--username",
      username,
      "--password",
      password,
    ],
    {
      cwd: root,
      env: { ...process.env, ADS_STATE_DIR: nodeStateDir },
      encoding: "utf8",
    },
  );
  assert(
    nodeAdmin.status === 0,
    `node init-admin failed:\n${nodeAdmin.stdout}\n${nodeAdmin.stderr}`,
  );

  const rustAdmin = spawnSync(
    path.join(rustDir, "target", "debug", "ads-server"),
    ["init-admin", "--username", username, "--password", password],
    {
      cwd: rustDir,
      env: { ...process.env, ADS_STATE_DIR: rustStateDir },
      encoding: "utf8",
    },
  );
  assert(
    rustAdmin.status === 0,
    `rust init-admin failed:\n${rustAdmin.stdout}\n${rustAdmin.stderr}`,
  );

  const nodePort = await getFreePort();
  const rustPort = await getFreePort();
  const nodeBase = `http://127.0.0.1:${nodePort}`;
  const rustBase = `http://127.0.0.1:${rustPort}`;
  const sharedEnv = {
    ALLOWED_DIRS: root,
    ADS_WEB_HOST: "127.0.0.1",
    ADS_WEB_COOKIE_SECURE: "0",
    ADS_WEB_ALLOWED_ORIGINS: "",
    ADS_WEB_MAX_CLIENTS: "32",
    ...(options.env ?? {}),
  };

  const nodeServer = startChild(
    process.execPath,
    [...nodeModuleArgs(nodeEntry), nodeEntry, ...(options.nodeArgs ?? [])],
    {
      cwd: options.nodeCwd ?? root,
      env: {
        ...process.env,
        ...sharedEnv,
        ...(options.nodeEnv ?? {}),
        ADS_STATE_DIR: nodeStateDir,
        ADS_WEB_PORT: String(nodePort),
      },
    },
    children,
  );
  let rustServer = null;
  const startRust = async (runtimeEnv = {}) => {
    rustServer = startChild(
      path.join(rustDir, "target", "debug", "ads-server"),
      [],
      {
        cwd: options.rustCwd ?? rustDir,
        env: {
          ...process.env,
          ...sharedEnv,
          ...(options.rustEnv ?? {}),
          ...runtimeEnv,
          ADS_STATE_DIR: rustStateDir,
          ADS_WEB_PORT: String(rustPort),
        },
      },
      children,
    );
    await waitForServer(rustBase, rustServer);
  };

  await Promise.all([waitForServer(nodeBase, nodeServer), startRust()]);

  return {
    nodeBase,
    rustBase,
    nodeStateDir,
    rustStateDir,
    username,
    password,
    nodeRequest: (pathname, requestOptions) => request(nodeBase, pathname, requestOptions),
    rustRequest: (pathname, requestOptions) => request(rustBase, pathname, requestOptions),
    async compareBoth(label, pathname, requestOptions, compareOptions) {
      await compare(
        label,
        await request(nodeBase, pathname, requestOptions),
        await request(rustBase, pathname, requestOptions),
        compareOptions,
      );
    },
    nodeOutput: () => nodeServer.output(),
    rustOutput: () => rustServer.output(),
    async restartRust(runtimeEnv = {}) {
      await stopChild(rustServer.child);
      await startRust(runtimeEnv);
    },
    async stop() {
      await Promise.all(children.map(stopChild));
      for (const directory of [nodeStateDir, rustStateDir]) {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup only.
        }
      }
    },
  };
}
