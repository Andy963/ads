import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AsyncLock } from "../../server/utils/asyncLock.js";
import { ConversationLogger } from "../../server/utils/conversationLogger.js";
import { RotatingLogFile } from "../../server/utils/rotatingLogFile.js";
import {
  recordConversationMessage,
  setConversationMessageRecorder,
  type ConversationMessage,
} from "../../server/utils/conversationMessageRecorder.js";

const { loadEnv, resetEnvForTests } = await import("../../server/utils/env.js");
const { parseCsv } = await import("../../server/utils/text.js");

describe("AsyncLock", () => {
  it("cancels a queued acquisition without blocking later work", async () => {
    const lock = new AsyncLock();
    let releaseFirst!: () => void;
    const first = lock.runExclusive(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    while (!releaseFirst) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const controller = new AbortController();
    let canceledRan = false;
    const canceled = lock.runExclusive(async () => {
      canceledRan = true;
    }, controller.signal);
    const third = lock.runExclusive(async () => "done");

    controller.abort();
    await assert.rejects(canceled, (error: unknown) => {
      return error instanceof Error && error.name === "AbortError";
    });

    releaseFirst();
    await first;
    assert.equal(await third, "done");
    assert.equal(canceledRan, false);
    assert.equal(lock.isBusy(), false);
  });
});

async function waitForFileContent(filePath: string, predicate: (content: string) => boolean): Promise<string> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      if (predicate(content)) {
        return content;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for conversation log content: ${filePath}`);
}

describe("ConversationLogger", () => {
  it("does not persist or attach Native execution ids when thread persistence is disabled", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-conversation-log-"));
    const logger = new ConversationLogger(workspace, 1, "native-execution-id", {
      persistThreadId: false,
    });

    try {
      assert.equal(path.basename(logger.path).includes("native-execution-id"), false);
      logger.attachThreadId("native-execution-id");
      logger.logOutput("done");
      logger.close();

      const content = await waitForFileContent(
        logger.path,
        (value) => value.includes("done"),
      );
      assert.equal(content.includes("native-execution-id"), false);
      assert.equal(content.includes("Thread ID"), false);
    } finally {
      logger.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("redacts Native execution ids embedded in event details", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-event-log-"));
    const logger = new ConversationLogger(workspace, 1, undefined, {
      persistThreadId: false,
    });

    try {
      logger.logEvent({
        phase: "connection",
        title: "thread#native-8f3c2d1a-1111-2222-3333-444455556666",
        detail: "Started thread#native-8f3c2d1a-1111-2222-3333-444455556666",
        raw: { type: "thread.started" },
        timestamp: Date.now(),
      } as any);
      logger.close();

      const content = await waitForFileContent(
        logger.path,
        (value) => value.includes("EVENT"),
      );
      assert.equal(content.includes("native-8f3c2d1a"), false);
      assert.match(content, /native-execution-id-redacted/);
      assert.equal(content.includes("thread.started"), true);
    } finally {
      logger.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("conversation message recorder", () => {
  const message: ConversationMessage = {
    eventId: "event-1",
    workspaceRoot: "/workspace",
    sessionId: "session-1",
    source: "web",
    role: "user",
    text: "hello",
    agentId: "codex",
  };

  afterEach(() => setConversationMessageRecorder(null));

  it("publishes normalized messages to the configured recorder", () => {
    const recorded: ConversationMessage[] = [];
    setConversationMessageRecorder({ record: (entry) => recorded.push(entry) });
    recordConversationMessage(message);
    assert.deepEqual(recorded, [message]);
  });

  it("isolates recorder failures from the caller", () => {
    setConversationMessageRecorder({ record: () => { throw new Error("observer failed"); } });
    assert.doesNotThrow(() => recordConversationMessage(message));
  });
});

const RESTORED_ENV_KEYS = [
  "ADS_ENV_PATH",
  "ADS_ENV_SEARCH_MAX_DEPTH",
  "ENV_TEST_KEY",
  "ENV_TEST_BOUNDARY_KEY",
  "ENV_TEST_TOO_DEEP",
];

const savedEnv = new Map<string, string | undefined>(
  RESTORED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

describe("utils/env", () => {
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  function mkdtemp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    process.chdir(originalCwd);
    resetEnvForTests();

    for (const key of RESTORED_ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops searching above repo sentinel", () => {
    const parentDir = mkdtemp("ads-env-boundary-");
    const repoDir = path.join(parentDir, "repo");
    const nestedDir = path.join(repoDir, "a", "b", "c");
    fs.mkdirSync(nestedDir, { recursive: true });

    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "repo" }), "utf8");
    fs.writeFileSync(path.join(parentDir, ".env"), "ENV_TEST_BOUNDARY_KEY=1\n", "utf8");

    delete process.env.ADS_ENV_PATH;
    delete process.env.ADS_ENV_SEARCH_MAX_DEPTH;
    delete process.env.ENV_TEST_BOUNDARY_KEY;

    process.chdir(nestedDir);
    resetEnvForTests();
    loadEnv();

    assert.equal(process.env.ENV_TEST_BOUNDARY_KEY, undefined);
  });

  it("respects ADS_ENV_PATH (and optional .local override)", () => {
    const dir = mkdtemp("ads-env-explicit-");
    const envPath = path.join(dir, "custom.env");
    fs.writeFileSync(envPath, "ENV_TEST_KEY=base\n", "utf8");
    fs.writeFileSync(`${envPath}.local`, "ENV_TEST_KEY=override\n", "utf8");

    process.env.ADS_ENV_PATH = envPath;
    delete process.env.ADS_ENV_SEARCH_MAX_DEPTH;
    delete process.env.ENV_TEST_KEY;

    resetEnvForTests();
    loadEnv();

    assert.equal(process.env.ENV_TEST_KEY, "override");
  });

  it("limits upward search depth when no repo sentinel exists", () => {
    const root = mkdtemp("ads-env-depth-");
    fs.writeFileSync(path.join(root, ".env"), "ENV_TEST_TOO_DEEP=1\n", "utf8");

    let current = root;
    for (let i = 0; i < 10; i += 1) {
      current = path.join(current, `d${i}`);
    }
    fs.mkdirSync(current, { recursive: true });

    delete process.env.ADS_ENV_PATH;
    process.env.ADS_ENV_SEARCH_MAX_DEPTH = "2";
    delete process.env.ENV_TEST_TOO_DEEP;

    process.chdir(current);
    resetEnvForTests();
    loadEnv();

    assert.equal(process.env.ENV_TEST_TOO_DEEP, undefined);
  });
});

describe("RotatingLogFile", () => {
  it("rotates before exceeding maxBytes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-rotating-log-"));
    const basePath = path.join(dir, "ads.log");
    const maxBytes = 100;

    const sink = new RotatingLogFile(basePath, { maxBytes });
    const line = "x".repeat(40) + "\n"; // 41 bytes

    for (let i = 0; i < 10; i += 1) {
      sink.write(line);
    }
    await sink.closeAsync();

    const entries = fs.readdirSync(dir).sort();
    assert.ok(entries.length >= 2, `expected rotated logs, got: ${entries.join(", ")}`);

    for (const entry of entries) {
      const size = fs.statSync(path.join(dir, entry)).size;
      assert.ok(size <= maxBytes, `expected ${entry} <= ${maxBytes}, got ${size}`);
    }
  });

  it("starts a new segment when base log is already oversized", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-rotating-log-"));
    const basePath = path.join(dir, "ads.log");
    const maxBytes = 100;

    fs.writeFileSync(basePath, "x".repeat(200), "utf8");
    fs.writeFileSync(path.join(dir, "ads.1.log"), "seed", "utf8");

    const sink = new RotatingLogFile(basePath, { maxBytes });
    assert.equal(path.basename(sink.path), "ads.2.log");

    sink.write("hello\n");
    await sink.closeAsync();

    const size = fs.statSync(path.join(dir, "ads.2.log")).size;
    assert.ok(size > 0 && size <= maxBytes);
  });
});

describe("utils/text", () => {
  it("parseCsv splits and trims entries", () => {
    assert.deepEqual(parseCsv(undefined), []);
    assert.deepEqual(parseCsv(""), []);
    assert.deepEqual(parseCsv("   "), []);
    assert.deepEqual(parseCsv("a,b,c"), ["a", "b", "c"]);
    assert.deepEqual(parseCsv(" a , b , , c "), ["a", "b", "c"]);
  });
});
