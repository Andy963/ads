/**
 * Black-box WebSocket conformance for workspace restore precedence: a project
 * root wins over process workspace caches, and chat lanes for one auth session
 * share the active and saved workspace state.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { assert, loginAs, request, startServerPair } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");
const chatSessionId = "main";

function connect(baseUrl, cookie, protocols) {
  const url = `${baseUrl.replace(/^http/, "ws")}/ws`;
  const socket = new WebSocket(url, protocols, { headers: { cookie } });
  const frames = [];
  const waiters = [];
  let failure = null;

  const flush = () => {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (frames.length > 0) {
        waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(frames.shift());
        continue;
      }
      if (failure) {
        waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(failure);
        continue;
      }
      break;
    }
  };

  socket.on("message", (data) => {
    try {
      frames.push(JSON.parse(String(data)));
    } catch (error) {
      failure = new Error(`invalid JSON frame: ${String(data)} (${error})`);
    }
    flush();
  });
  socket.on("error", (error) => {
    failure = error;
    flush();
  });

  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  const next = (timeoutMs = 8_000) =>
    new Promise((resolve, reject) => {
      if (frames.length > 0) {
        resolve(frames.shift());
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for a WebSocket frame; recent=${JSON.stringify(frames)}`));
      }, timeoutMs);
      waiters.push(waiter);
    });

  return {
    socket,
    opened,
    closed,
    next,
    async take(count) {
      const out = [];
      for (let index = 0; index < count; index += 1) out.push(await next());
      return out;
    },
    close: () => socket.close(),
  };
}

async function runCacheSide(baseUrl, username, password, otherRoot) {
  const { cookie } = await loginAs(baseUrl, username, password);
  const sessionId = "workspace-cache-session";
  const protocols = (chatSessionId) => ["ads-v1", `ads-session.${sessionId}`, `ads-chat.${chatSessionId}`];
  const captured = {};

  const first = connect(baseUrl, cookie, protocols("main"));
  await first.opened;
  await first.take(3);
  const baselinePwd = await pwd(first, "workspace-cache-baseline");
  captured.baselinePwd = baselinePwd;
  first.socket.send(JSON.stringify({ type: "command", payload: `/cd ${otherRoot}` }));
  captured.cd = await takeUntil(first, (frame) => frame.type === "workspace", "cache cd workspace");

  const second = connect(baseUrl, cookie, protocols("acopilot"));
  await second.opened;
  try {
    await second.take(3);
    captured.sharedPwd = await pwd(second, "workspace-cache-shared");
  } finally {
    second.close();
  }
  first.close();
  await Promise.all([first.closed, second.closed]);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const third = connect(baseUrl, cookie, protocols("cache-third"));
  await third.opened;
  try {
    await third.take(3);
    captured.sessionPwd = await pwd(third, "workspace-cache-session-state");
  } finally {
    third.close();
  }
  await third.closed;
  return captured;
}

function normalize(frame) {
  const clone = { ...frame };
  delete clone.seq;
  delete clone.ts;
  return clone;
}

async function takeUntil(client, predicate, label) {
  const frames = [];
  for (let index = 0; index < 12; index += 1) {
    const frame = await client.next();
    frames.push(frame);
    if (predicate(frame)) return frames;
  }
  throw new Error(`no ${label} frame: ${JSON.stringify(frames)}`);
}

async function pwd(client, clientMessageId) {
  client.socket.send(
    JSON.stringify({
      type: "command",
      client_message_id: clientMessageId,
      payload: "/pwd",
    }),
  );
  return await takeUntil(
    client,
    (frame) => frame.type === "result" && typeof frame.output === "string",
    "pwd result",
  );
}

async function runSide(baseUrl, username, password, projectRoot, otherRoot) {
  const { cookie } = await loginAs(baseUrl, username, password);
  const created = await request(baseUrl, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: projectRoot }),
  });
  assert(created.status === 200, `project create failed with ${created.status}`);
  const projectId = created.body?.project?.id;
  assert(typeof projectId === "string" && projectId.length > 0, "project id is missing");
  assert(
    created.body?.project?.workspaceRoot === projectRoot,
    `project workspaceRoot is ${created.body?.project?.workspaceRoot}`,
  );

  const protocols = ["ads-v1", `ads-session.${projectId}`, `ads-chat.${chatSessionId}`];
  const captured = { projectId };

  const first = connect(baseUrl, cookie, protocols);
  await first.opened;
  try {
    await first.take(3);
    captured.initialPwd = await pwd(first, "project-cwd-initial");
    first.socket.send(JSON.stringify({ type: "command", payload: `/cd ${otherRoot}` }));
    captured.cd = await takeUntil(first, (frame) => frame.type === "workspace", "cd workspace");
  } finally {
    first.close();
  }

  const second = connect(baseUrl, cookie, protocols);
  await second.opened;
  try {
    await second.take(3);
    captured.restoredPwd = await pwd(second, "project-cwd-restored");
  } finally {
    second.close();
  }
  return captured;
}

function compareFrames(label, node, rust) {
  assert(
    JSON.stringify(normalize(node)) === JSON.stringify(normalize(rust)),
    `${label}: node=${JSON.stringify(normalize(node))} rust=${JSON.stringify(normalize(rust))}`,
  );
}

function compareFrameLists(label, nodeFrames, rustFrames) {
  assert(nodeFrames.length === rustFrames.length, `${label}: frame counts differ`);
  nodeFrames.forEach((frame, index) => compareFrames(`${label}[${index}]`, frame, rustFrames[index]));
}

function findNodeModules(start) {
  let current = start;
  for (;;) {
    const candidate = path.join(current, "node_modules");
    if (fs.existsSync(path.join(candidate, "tsx"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("node_modules with tsx not found");
    current = parent;
  }
}

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ads-project-cwd-"));
  const projectRoot = path.join(sandbox, "project");
  const otherRoot = path.join(sandbox, "other");
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(otherRoot);
  fs.symlinkSync(findNodeModules(root), path.join(sandbox, "node_modules"), "dir");
  const pair = await startServerPair({
    root,
    rustDir,
    nodeEntry: path.join(root, "ts-server", "server", "web", "server_impl.ts"),
    nodeCwd: sandbox,
    rustCwd: sandbox,
  });
  try {
    const node = await runSide(
      pair.nodeBase,
      pair.username,
      pair.password,
      projectRoot,
      otherRoot,
    );
    let rust;
    try {
      rust = await runSide(
        pair.rustBase,
        pair.username,
        pair.password,
        projectRoot,
        otherRoot,
      );
    } catch (error) {
      console.error("rust server output:", pair.rustOutput());
      throw error;
    }
    const nodeCache = await runCacheSide(pair.nodeBase, pair.username, pair.password, otherRoot);
    let rustCache;
    try {
      rustCache = await runCacheSide(pair.rustBase, pair.username, pair.password, otherRoot);
    } catch (error) {
      console.error("rust server output:", pair.rustOutput());
      throw error;
    }

    assert(node.projectId === rust.projectId, "project ids differ");
    compareFrameLists("initial pwd", node.initialPwd, rust.initialPwd);
    compareFrameLists("cd away", node.cd, rust.cd);
    compareFrameLists("restored pwd", node.restoredPwd, rust.restoredPwd);
    compareFrameLists("cache baseline pwd", nodeCache.baselinePwd, rustCache.baselinePwd);
    compareFrameLists("cache cd", nodeCache.cd, rustCache.cd);
    compareFrameLists("cache shared pwd", nodeCache.sharedPwd, rustCache.sharedPwd);
    compareFrameLists("cache session pwd", nodeCache.sessionPwd, rustCache.sessionPwd);

    assert(
      node.initialPwd.at(-1)?.output === `当前工作目录: ${projectRoot}` &&
        rust.initialPwd.at(-1)?.output === `当前工作目录: ${projectRoot}`,
      "initial cwd did not come from the project workspace",
    );
    assert(
      node.cd.at(-1)?.data?.path === otherRoot && rust.cd.at(-1)?.data?.path === otherRoot,
      "cd did not move the lane away from the project workspace",
    );
    assert(
      node.restoredPwd.at(-1)?.output === `当前工作目录: ${projectRoot}` &&
        rust.restoredPwd.at(-1)?.output === `当前工作目录: ${projectRoot}`,
      "project workspace did not win over the persisted cwd on reconnect",
    );
    assert(
      nodeCache.sharedPwd.at(-1)?.output === `当前工作目录: ${otherRoot}` &&
        rustCache.sharedPwd.at(-1)?.output === `当前工作目录: ${otherRoot}`,
      "workspace cache was not shared across chat lanes in the same auth session",
    );
    assert(
      nodeCache.sessionPwd.at(-1)?.output === `当前工作目录: ${otherRoot}` &&
        rustCache.sessionPwd.at(-1)?.output === `当前工作目录: ${otherRoot}`,
      "session workspace state was not restored for a new chat lane",
    );

    console.log("ok: ws project cwd conformance");
  } finally {
    await pair.stop();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
