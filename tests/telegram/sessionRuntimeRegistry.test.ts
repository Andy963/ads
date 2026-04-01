import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionRuntimeRegistry } from "../../server/telegram/utils/sessionRuntimeRegistry.js";

type FakeSession = {
  workingDirectory?: string;
  threadId: string | null;
  resetCalls: number;
  setWorkingDirectory: (workingDirectory?: string) => void;
  getThreadId: () => string | null;
  reset: () => void;
};

type FakeLogger = {
  isClosed: boolean;
  closeCalls: number;
  attachedThreadIds: Array<string | null>;
  attachThreadId: (threadId: string | null) => void;
  close: () => void;
};

function createFakeSession(workingDirectory = "/tmp/project", threadId = "thread-1"): FakeSession {
  const session: FakeSession = {
    workingDirectory,
    threadId,
    resetCalls: 0,
    setWorkingDirectory: (nextWorkingDirectory) => {
      session.workingDirectory = nextWorkingDirectory;
    },
    getThreadId: () => session.threadId,
    reset: () => {
      session.resetCalls += 1;
    },
  };
  return session;
}

function createFakeLogger(): FakeLogger {
  const logger: FakeLogger = {
    isClosed: false,
    closeCalls: 0,
    attachedThreadIds: [],
    attachThreadId: (threadId) => {
      logger.attachedThreadIds.push(threadId);
    },
    close: () => {
      logger.isClosed = true;
      logger.closeCalls += 1;
    },
  };
  return logger;
}

describe("telegram/sessionRuntimeRegistry", () => {
  it("updates working directories and closes any active logger", () => {
    const registry = new SessionRuntimeRegistry<FakeSession, FakeLogger>();
    const session = createFakeSession("/tmp/a");
    const logger = createFakeLogger();

    registry.trackSession(1, session, "/tmp/a");
    registry.ensureLogger(1, true, () => logger);

    assert.equal(registry.updateWorkingDirectory(1, "/tmp/b"), true);
    assert.equal(session.workingDirectory, "/tmp/b");
    assert.equal(registry.getUserCwd(1), "/tmp/b");
    assert.equal(logger.closeCalls, 1);
    assert.equal(registry.getRecord(1)?.logger, undefined);
  });

  it("reuses open loggers and reattaches the current thread id", () => {
    const registry = new SessionRuntimeRegistry<FakeSession, FakeLogger>();
    const session = createFakeSession("/tmp/a", "thread-1");
    const logger = createFakeLogger();

    registry.trackSession(1, session, "/tmp/a");
    assert.equal(registry.ensureLogger(1, true, () => logger), logger);

    session.threadId = "thread-2";
    assert.equal(
      registry.ensureLogger(1, true, () => {
        throw new Error("should reuse existing logger");
      }),
      logger,
    );
    assert.deepEqual(logger.attachedThreadIds, ["thread-2"]);
  });

  it("tracks and migrates history injection continuity state", () => {
    const registry = new SessionRuntimeRegistry<FakeSession, FakeLogger>();

    registry.markHistoryInjection(10);
    registry.setContextRestoreMode(10, "history_injection");
    registry.migrateContinuityState(10, 20);

    assert.equal(registry.needsHistoryInjection(20), true);
    assert.equal(registry.getContextRestoreMode(20), "history_injection");

    registry.clearHistoryInjection(20);
    assert.equal(registry.needsHistoryInjection(20), false);
    assert.equal(registry.getContextRestoreMode(20), "fresh");
  });

  it("releases sessions by resetting them, closing loggers, and clearing continuity state", () => {
    const registry = new SessionRuntimeRegistry<FakeSession, FakeLogger>();
    const session = createFakeSession("/tmp/a");
    const logger = createFakeLogger();

    registry.trackSession(1, session, "/tmp/a");
    registry.ensureLogger(1, true, () => logger);
    registry.markHistoryInjection(1);
    registry.setContextRestoreMode(1, "history_injection");

    const released = registry.releaseSession(1);

    assert.equal(released?.session, session);
    assert.equal(session.resetCalls, 1);
    assert.equal(logger.closeCalls, 1);
    assert.equal(registry.hasSession(1), false);
    assert.equal(registry.needsHistoryInjection(1), false);
    assert.equal(registry.getContextRestoreMode(1), "fresh");
  });
});
