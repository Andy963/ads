import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionCallbackData,
  formatSessionListMessage,
  parseSessionCallbackData,
} from "../../server/telegram/utils/sessionListMessage.js";
import type { AgentSessionRef } from "../../server/agents/sessions/types.js";

const NOW = 1_700_000_000_000;

function makeSession(overrides: Partial<AgentSessionRef> = {}): AgentSessionRef {
  return {
    agentId: "codex",
    sessionId: "019fe877-648e-71c2-be8a-b703c537a9bd",
    cwd: "/repo",
    title: "修复登录超时",
    updatedAt: NOW - 30 * 60_000,
    source: "app_server",
    ...overrides,
  };
}

describe("telegram/utils/sessionListMessage", () => {
  it("round-trips a session id through callback data", () => {
    const data = buildSessionCallbackData("019fe877-648e-71c2-be8a-b703c537a9bd");
    assert.equal(data, "sr:019fe877-648e-71c2-be8a-b703c537a9bd");
    assert.equal(parseSessionCallbackData(data), "019fe877-648e-71c2-be8a-b703c537a9bd");
  });

  it("refuses callback data Telegram would reject", () => {
    // 64 bytes is the API cap; a longer id must not produce an unusable button.
    assert.equal(buildSessionCallbackData("x".repeat(70)), null);
    assert.equal(buildSessionCallbackData("   "), null);
    assert.equal(parseSessionCallbackData("vt:submit"), null);
    assert.equal(parseSessionCallbackData(undefined), null);
  });

  it("says plainly when nothing is resumable instead of sending an empty list", () => {
    const message = formatSessionListMessage({ items: [], agentId: "codex", cwd: "/repo", now: NOW });
    assert.match(message.text, /没有找到可恢复的会话/);
    assert.deepEqual(message.buttons, []);
  });

  it("renders one button per session and labels its state", () => {
    const message = formatSessionListMessage({
      items: [
        makeSession({ isCurrent: true }),
        makeSession({ sessionId: "aaaaaaaa-1111-2222-3333-444444444444", title: "旧的工作", forkCount: 12, updatedAt: NOW - 3 * 24 * 3_600_000 }),
      ],
      agentId: "codex",
      cwd: "/repo",
      now: NOW,
    });

    assert.equal(message.buttons.length, 2);
    assert.equal(message.buttons[0].data, "sr:019fe877-648e-71c2-be8a-b703c537a9bd");
    assert.match(message.text, /1\. 修复登录超时 ［当前］/);
    assert.match(message.text, /30 分钟前/);
    assert.match(message.text, /2\. 旧的工作 ［分支 12］/);
    assert.match(message.text, /3 天前/);
  });

  it("reports folded and withheld rows so a short list is not read as complete", () => {
    const message = formatSessionListMessage({
      items: [makeSession()],
      agentId: "claude",
      cwd: "/repo",
      now: NOW,
      hidden: { singleTurn: 35, duplicates: 4, forks: 52 },
      degraded: ["codex_app_server"],
    });

    assert.match(message.text, /已合并 52 个同对话的历史分支/);
    assert.match(message.text, /已隐藏 39 个一次性\/重名会话/);
    assert.match(message.text, /部分来源不可用/);
  });

  it("truncates a long title on a character boundary", () => {
    const long = "登".repeat(40);
    const message = formatSessionListMessage({
      items: [makeSession({ title: long })],
      agentId: "codex",
      cwd: "/repo",
      now: NOW,
    });
    const label = message.buttons[0].label;
    assert.equal(Array.from(label).length, "1. ".length + 24 + 1);
    assert.ok(label.endsWith("…"));
  });
});
