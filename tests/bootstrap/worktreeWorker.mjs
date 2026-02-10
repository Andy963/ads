import { parentPort, workerData } from "node:worker_threads";

import { register } from "tsx/esm/api";

function asMessage(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value;
}

function waitForStart(port) {
  return new Promise((resolve, reject) => {
    const onMessage = (msg) => {
      const parsed = asMessage(msg);
      if (parsed.type === "start") {
        port.off("message", onMessage);
        resolve();
      }
    };
    port.on("message", onMessage);
    port.once("close", () => reject(new Error("parentPort closed")));
  });
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function main() {
  if (!parentPort) {
    throw new Error("missing parentPort");
  }

  const payload = workerData;
  parentPort.postMessage({ type: "ready" });
  await waitForStart(parentPort);

  try {
    register();
    const { prepareBootstrapWorktree } = await import("../../src/bootstrap/worktree.js");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const worktree = await prepareBootstrapWorktree({
        project: { kind: "local_path", value: payload.projectPath },
        branchPrefix: payload.branchPrefix,
        stateDir: payload.stateDir,
        signal: controller.signal,
      });
      parentPort.postMessage({ type: "result", ok: true, worktree });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    parentPort.postMessage({ type: "result", ok: false, error: toErrorMessage(error) });
  }
}

void main();

