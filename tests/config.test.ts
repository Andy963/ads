import path from "node:path";
import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  resolveAgentConfig,
  resolveSharedConfig,
  resolveTelegramConfig,
  resolveWebConfig,
} from "../server/config.js";

describe("server config resolvers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves shared allowed dirs for web entrypoints", () => {
    const config = resolveSharedConfig({
      env: {
        ALLOWED_DIRS: "./workspace, /tmp/project ",
        SANDBOX_MODE: "read-only",
      },
      fallbackAllowedDir: "/fallback/root",
      resolveAllowedDirPaths: true,
      fallbackWhenAllowedDirsEmpty: true,
    });

    assert.deepStrictEqual(config.allowedDirs, [
      path.resolve("./workspace"),
      path.resolve("/tmp/project"),
    ]);
    assert.strictEqual(config.sandboxMode, "read-only");
  });

  it("applies web defaults and trims optional models", () => {
    const config = resolveWebConfig({
      env: {
        ADS_WEB_PORT: "0",
        ADS_WEB_MAX_CLIENTS: "2.9",
        ADS_WEB_WS_PING_INTERVAL_MS: "-5",
        ADS_WEB_WS_MAX_MISSED_PONGS: "not-a-number",
        ADS_PLANNER_CODEX_MODEL: " gpt-5.4 ",
        ADS_REVIEWER_CODEX_MODEL: "   ",
        TASK_QUEUE_ENABLED: "off",
        TASK_QUEUE_AUTO_START: "yes",
        ADS_TRACE_WS_DUPLICATION: "true",
      },
    });

    assert.strictEqual(config.port, 8787);
    assert.strictEqual(config.host, "127.0.0.1");
    assert.strictEqual(config.maxClients, 2);
    assert.strictEqual(config.wsPingIntervalMs, 0);
    assert.strictEqual(config.wsMaxMissedPongs, 3);
    assert.strictEqual(config.sessionTimeoutMs, 24 * 60 * 60 * 1000);
    assert.strictEqual(config.sessionCleanupIntervalMs, 5 * 60 * 1000);
    assert.strictEqual(config.plannerCodexModel, "gpt-5.4");
    assert.strictEqual(config.reviewerCodexModel, undefined);
    assert.strictEqual(config.taskQueueEnabled, false);
    assert.strictEqual(config.taskQueueAutoStart, true);
    assert.strictEqual(config.traceWsDuplication, true);
  });

  it("supports env overrides for web session idle reclaim config", () => {
    const configHours = resolveWebConfig({
      env: {
        ADS_WEB_SESSION_TIMEOUT_HOURS: "12",
        ADS_WEB_SESSION_CLEANUP_INTERVAL_MINUTES: "1",
      },
    });
    assert.strictEqual(configHours.sessionTimeoutMs, 12 * 60 * 60 * 1000);
    assert.strictEqual(configHours.sessionCleanupIntervalMs, 1 * 60 * 1000);

    const configMs = resolveWebConfig({
      env: {
        ADS_WEB_SESSION_TIMEOUT_HOURS: "12",
        ADS_WEB_SESSION_TIMEOUT_MS: "60000",
        ADS_WEB_SESSION_CLEANUP_INTERVAL_MINUTES: "1",
        ADS_WEB_SESSION_CLEANUP_INTERVAL_MS: "12345",
      },
    });
    assert.strictEqual(configMs.sessionTimeoutMs, 60000);
    assert.strictEqual(configMs.sessionCleanupIntervalMs, 12345);
  });

  it("applies agent defaults when flags are missing or invalid", () => {
    const config = resolveAgentConfig({
      env: {
        ADS_SKILLS_AUTOLOAD: "no",
        ADS_TASK_TIMEOUT_MS: "invalid",
        ADS_TASK_MAX_ATTEMPTS: "-1",
      },
    });

    assert.strictEqual(config.skillAutoloadEnabled, false);
    assert.strictEqual(config.skillAutosaveEnabled, true);
    assert.strictEqual(config.preferenceDirectiveEnabled, true);
    assert.strictEqual(config.taskMaxParallel, 3);
    assert.strictEqual(config.taskTimeoutMs, 2 * 60 * 1000);
    assert.strictEqual(config.taskMaxAttempts, 2);
    assert.strictEqual(config.taskRetryBackoffMs, 1200);
  });

  it("resolves telegram defaults and normalizes proxy urls", () => {
    const config = resolveTelegramConfig({
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_USER_ID: "123456",
        TELEGRAM_PROXY_URL: "127.0.0.1:7890",
      },
      fallbackAllowedDir: "/workspace/root",
    });

    assert.strictEqual(config.botToken, "bot-token");
    assert.deepStrictEqual(config.allowedUsers, [123456]);
    assert.deepStrictEqual(config.allowedDirs, ["/workspace/root"]);
    assert.strictEqual(config.maxRequestsPerMinute, 10);
    assert.strictEqual(config.sessionTimeoutMs, 24 * 60 * 60 * 1000);
    assert.strictEqual(config.streamUpdateIntervalMs, 1500);
    assert.strictEqual(config.sandboxMode, "workspace-write");
    assert.strictEqual(config.proxyUrl, "http://127.0.0.1:7890");
  });
});
