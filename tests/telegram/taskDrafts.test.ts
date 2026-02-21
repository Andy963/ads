import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import { resetDatabaseForTests } from "../../src/storage/database.js";
import { TaskStore } from "../../src/tasks/store_impl.js";
import {
  cancelTelegramTaskDraft,
  confirmTelegramTaskDraft,
  createTelegramTaskDraft,
  deriveTelegramAuthUserId,
  getTelegramTaskDraft,
} from "../../src/telegram/utils/taskDrafts.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("telegram/taskDrafts", () => {
  const originalEnv = { ...process.env };
  let tempAdsState: TempAdsStateDir | null = null;
  let workspaceA = "";
  let workspaceB = "";

  beforeEach(() => {
    tempAdsState = installTempAdsStateDir("ads-tg-draft-");
    process.env.ADS_STATE_DB_PATH = path.join(tempAdsState.stateDir, "state.db");
    resetStateDatabaseForTests();
    resetDatabaseForTests();

    workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), "ads-ws-a-"));
    workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), "ads-ws-b-"));
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    resetDatabaseForTests();

    try {
      fs.rmSync(workspaceA, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(workspaceB, { recursive: true, force: true });
    } catch {
      // ignore
    }

    try {
      tempAdsState?.restore();
    } catch {
      // ignore
    }
    tempAdsState = null;
    process.env = { ...originalEnv };
  });

  it("confirms draft idempotently and uses captured workspaceRoot", () => {
    const authUserId = deriveTelegramAuthUserId(1);

    const draft = createTelegramTaskDraft({
      authUserId,
      workspaceRoot: workspaceA,
      sourceChatSessionId: "tg:chat",
      text: "do something",
      now: 1000,
    });

    process.env.AD_WORKSPACE = workspaceB;

    const confirmed = confirmTelegramTaskDraft({ authUserId, draftId: draft.id, now: 2000 });
    assert.equal(confirmed.status, "ok");

    const storeA = new TaskStore({ workspacePath: workspaceA });
    const storeB = new TaskStore({ workspacePath: workspaceB });
    assert.equal(storeA.listTasks({ limit: 10 }).length, 1);
    assert.equal(storeB.listTasks({ limit: 10 }).length, 0);

    const second = confirmTelegramTaskDraft({ authUserId, draftId: draft.id, now: 2001 });
    assert.equal(second.status, "already_approved");
    assert.equal(storeA.listTasks({ limit: 10 }).length, 1);

    const reread = getTelegramTaskDraft({ authUserId, draftId: draft.id });
    assert.ok(reread);
    assert.equal(reread.status, "approved");
  });

  it("cancels draft and blocks later confirm", () => {
    const authUserId = deriveTelegramAuthUserId(2);

    const draft = createTelegramTaskDraft({
      authUserId,
      workspaceRoot: workspaceA,
      sourceChatSessionId: "tg:chat",
      text: "do something else",
      now: 1000,
    });

    const cancelled = cancelTelegramTaskDraft({ authUserId, draftId: draft.id, now: 1500 });
    assert.equal(cancelled.status, "cancelled");

    const confirm = confirmTelegramTaskDraft({ authUserId, draftId: draft.id, now: 1600 });
    assert.equal(confirm.status, "cancelled");

    const storeA = new TaskStore({ workspacePath: workspaceA });
    assert.equal(storeA.listTasks({ limit: 10 }).length, 0);

    const reread = getTelegramTaskDraft({ authUserId, draftId: draft.id });
    assert.ok(reread);
    assert.equal(reread.status, "deleted");
  });

  it("refuses to cancel an approved draft", () => {
    const authUserId = deriveTelegramAuthUserId(3);

    const draft = createTelegramTaskDraft({
      authUserId,
      workspaceRoot: workspaceA,
      sourceChatSessionId: "tg:chat",
      text: "do approved task",
      now: 1000,
    });

    const confirmed = confirmTelegramTaskDraft({ authUserId, draftId: draft.id, now: 1200 });
    assert.equal(confirmed.status, "ok");

    const cancelled = cancelTelegramTaskDraft({ authUserId, draftId: draft.id, now: 1300 });
    assert.equal(cancelled.status, "already_approved");

    const reread = getTelegramTaskDraft({ authUserId, draftId: draft.id });
    assert.ok(reread);
    assert.equal(reread.status, "approved");
  });

  it("does not enqueue when workspaceRoot becomes unavailable", () => {
    const authUserId = deriveTelegramAuthUserId(4);

    const draft = createTelegramTaskDraft({
      authUserId,
      workspaceRoot: workspaceA,
      sourceChatSessionId: "tg:chat",
      text: "do unavailable workspace task",
      now: 1000,
    });

    fs.rmSync(workspaceA, { recursive: true, force: true });

    const confirmed = confirmTelegramTaskDraft({ authUserId, draftId: draft.id, now: 2000 });
    assert.equal(confirmed.status, "workspace_unavailable");

    const reread = getTelegramTaskDraft({ authUserId, draftId: draft.id });
    assert.ok(reread);
    assert.equal(reread.status, "draft");
  });
});

