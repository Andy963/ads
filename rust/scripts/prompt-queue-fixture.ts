import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");

type Mode = "create" | "verify";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function openState(dbPath: string) {
  process.env.ADS_STATE_DB_PATH = dbPath;
  const { getStateDatabase } = await import(path.join(root, "server/state/database.ts"));
  return getStateDatabase(dbPath);
}

function lane() {
  return {
    authUserId: "user-1",
    sessionId: "session-1",
    chatSessionId: "main",
    historyKey: "user-1::session-1::main",
    logicalHistoryKey: "user-1::session-1::main",
    laneNamespace: "web-actions",
    laneGeneration: 1,
  };
}

async function create(dbPath: string) {
  const { createPromptQueueStore } = await import(
    path.join(root, "server/state/promptQueueStore.ts")
  );
  const store = createPromptQueueStore(await openState(dbPath));
  store.enqueue({
    ...lane(),
    clientMessageId: "cm-ts-1",
    userId: 42,
    workspaceRoot: "/work/ads",
    payload: { text: "ts first", images: [] },
    createdAt: 100,
  });
  store.enqueue({
    ...lane(),
    clientMessageId: "cm-ts-2",
    userId: 42,
    workspaceRoot: "/work/ads",
    payload: { text: "ts second", images: [] },
    createdAt: 110,
  });
  console.log(JSON.stringify({ mode: "create", entries: store.listLogicalLane(lane()) }));
}

async function verify(dbPath: string) {
  const { createPromptQueueStore } = await import(
    path.join(root, "server/state/promptQueueStore.ts")
  );
  const store = createPromptQueueStore(await openState(dbPath));
  const entries = store.listLogicalLane(lane());
  const queued = entries.find((entry) => entry.clientMessageId === "cm-rust-1");
  const failed = entries.find((entry) => entry.clientMessageId === "cm-rust-2");
  assert(queued, "TypeScript did not see the Rust queued prompt");
  assert(queued.status === "queued", `unexpected Rust queued status: ${queued.status}`);
  assert(queued.payload.text === "rust queued", "Rust payload did not round-trip");
  assert(failed, "TypeScript did not see the Rust failed prompt");
  assert(failed.status === "failed", `unexpected Rust failed status: ${failed.status}`);
  assert(failed.attempts === 1, `unexpected Rust attempts: ${failed.attempts}`);
  assert(failed.lastError === "rust failure", `unexpected Rust error: ${failed.lastError}`);

  const cancelled = store.cancel({
    ...lane(),
    clientMessageId: "cm-ts-1",
    userId: 42,
  });
  assert(cancelled.cancelled, "TypeScript could not cancel its queued prompt");
  store.enqueue({
    ...lane(),
    clientMessageId: "cm-ts-after",
    userId: 42,
    workspaceRoot: "/work/ads",
    payload: { text: "after rust", images: [] },
    createdAt: 300,
  });

  console.log(
    JSON.stringify({
      mode: "verify",
      entries: store.listLogicalLane(lane()),
      cancelled: cancelled.reason,
    }),
  );
}

async function main() {
  const [, , modeArg, dbPath] = process.argv;
  const mode = modeArg as Mode | undefined;
  if (!mode || !dbPath || !fs.existsSync(path.dirname(dbPath))) {
    throw new Error("usage: prompt-queue-fixture.ts <create|verify> <dbPath>");
  }
  if (mode === "create") {
    await create(dbPath);
    return;
  }
  if (mode === "verify") {
    await verify(dbPath);
    return;
  }
  throw new Error(`unknown mode: ${mode}`);
}

await main();
