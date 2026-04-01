import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { restoreConnectionWorkspace } from "../../server/web/server/ws/connectionWorkspace.js";

describe("web/ws/connectionWorkspace", () => {
  it("migrates legacy cwd keys and restores the preferred project cwd", () => {
    const persisted: Array<Array<[string, string]>> = [];
    const sessionManagerCalls: string[] = [];
    let currentCwd = "/workspace/root";
    const cwdStore = new Map<string, string>([["1001", "/workspace/legacy"]]);
    const workspaceCache = new Map<string, string>([["user::session", "/workspace/cached"]]);

    const result = restoreConnectionWorkspace({
      userId: 101,
      legacyUserId: 1001,
      cacheKey: "user::session",
      preferredProjectCwd: "/workspace/project",
      directoryManager: {
        getUserCwd: () => currentCwd,
        setUserCwd: (_userId: number, value: string) => {
          currentCwd = value;
          return { success: true };
        },
      } as any,
      sessionManager: {
        getSavedState: () => ({ cwd: "/workspace/saved" }),
        setUserCwd: (_userId: number, value: string) => {
          sessionManagerCalls.push(value);
        },
      } as any,
      workspaceCache,
      cwdStore,
      cwdStorePath: "/tmp/state.db",
      persistCwdStore: (_storePath, store) => {
        persisted.push(Array.from(store.entries()));
      },
      warn: () => {},
    });

    assert.equal(result, "/workspace/project");
    assert.equal(cwdStore.get("101"), "/workspace/project");
    assert.equal(workspaceCache.get("user::session"), "/workspace/project");
    assert.deepEqual(sessionManagerCalls, ["/workspace/project"]);
    assert.equal(persisted.length, 3);
  });

  it("falls back to current cwd when preferred restoration fails", () => {
    const warnings: string[] = [];
    const sessionManagerCalls: string[] = [];
    const cwdStore = new Map<string, string>([["202", "/workspace/stored"]]);
    const workspaceCache = new Map<string, string>();

    const result = restoreConnectionWorkspace({
      userId: 202,
      legacyUserId: 2002,
      cacheKey: "user::session",
      preferredProjectCwd: null,
      directoryManager: {
        getUserCwd: () => "/workspace/root",
        setUserCwd: () => ({ success: false, error: "denied" }),
      } as any,
      sessionManager: {
        getSavedState: () => ({ cwd: "/workspace/saved" }),
        setUserCwd: (_userId: number, value: string) => {
          sessionManagerCalls.push(value);
        },
      } as any,
      workspaceCache,
      cwdStore,
      cwdStorePath: "/tmp/state.db",
      persistCwdStore: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
    });

    assert.equal(result, "/workspace/root");
    assert.equal(workspaceCache.get("user::session"), "/workspace/root");
    assert.deepEqual(sessionManagerCalls, ["/workspace/root"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /WorkspaceRestore/);
  });
});
