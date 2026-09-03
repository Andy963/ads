import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatStepTraceLine,
  hasSubstantiveStepTrace,
  mapThreadEventToAgentEvent,
} from "../../server/codex/events.js";

describe("mapThreadEventToAgentEvent", () => {
  it("maps turn.started to analysis phase", () => {
    const event = { type: "turn.started" } as const;
    const mapped = mapThreadEventToAgentEvent(event, 0);
    assert(mapped);
    assert.equal(mapped.phase, "analysis");
    assert.equal(mapped.title, "开始处理请求");
  });

  it("does not format generic reasoning lifecycle events as step traces", () => {
    assert.equal(
      formatStepTraceLine({
        phase: "analysis",
        title: "Reasoning",
        timestamp: 0,
        raw: { type: "item.completed", item: { type: "reasoning" } } as any,
      }),
      null,
    );
    assert.equal(
      formatStepTraceLine({
        phase: "analysis",
        title: "开始处理请求",
        timestamp: 0,
        raw: { type: "turn.started" } as any,
      }),
      null,
    );
  });

  it("recognizes only non-analysis stages as persistable trace content", () => {
    assert.equal(hasSubstantiveStepTrace("[analysis] reasoning\n"), false);
    assert.equal(hasSubstantiveStepTrace("[analysis] reasoning[tool] Running tool\n"), true);
    assert.equal(hasSubstantiveStepTrace("[context] Loading context\n"), true);
  });

  it("maps command execution events to command phase", () => {
    const event = {
      type: "item.started" as const,
      item: {
        id: "cmd-1",
        type: "command_execution" as const,
        command: "npm test",
        aggregated_output: "",
        status: "in_progress" as const,
      },
    };

    const mapped = mapThreadEventToAgentEvent(event, 0);
    assert(mapped);
    assert.equal(mapped.phase, "command");
    assert.equal(mapped.title, "执行命令");
    assert(mapped.detail?.includes("npm test"));
  });

  it("maps agent message completion to responding phase", () => {
    const event = {
      type: "item.completed" as const,
      item: {
        id: "msg-1",
        type: "agent_message" as const,
        text: "回答内容",
      },
    };

    const mapped = mapThreadEventToAgentEvent(event, 0);
    assert(mapped);
    assert.equal(mapped.phase, "responding");
    assert.equal(mapped.detail, undefined);
  });

  it("maps file changes to concise editing stages without file paths", () => {
    const started = mapThreadEventToAgentEvent(
      {
        type: "item.started",
        item: {
          type: "file_change",
          id: "file-1",
          changes: [
            { kind: "update", path: "src/one.ts" },
            { kind: "update", path: "src/two.ts" },
          ],
        },
      },
      0,
    );
    assert(started);
    assert.equal(started.phase, "editing");
    assert.equal(started.title, "准备文件修改");
    assert.equal(started.detail, undefined);

    const completed = mapThreadEventToAgentEvent(
      {
        type: "item.completed",
        item: {
          type: "file_change",
          id: "file-1",
          changes: [{ kind: "update", path: "src/one.ts" }],
        },
      },
      0,
    );
    assert(completed);
    assert.equal(completed.phase, "editing");
    assert.equal(completed.title, "应用文件修改完成");
    assert.equal(completed.detail, undefined);
  });

  it("maps provider plan items to visible plan traces", () => {
    const mapped = mapThreadEventToAgentEvent(
      {
        type: "item.updated",
        item: { type: "plan", id: "plan-1", text: "Inspect the workspace" },
      } as any,
      0,
    );
    assert(mapped);
    assert.equal(mapped.phase, "plan");
    assert.equal(formatStepTraceLine(mapped), "[plan] Plan update: Inspect the workspace\n");
  });

  it("maps context compaction items to context traces", () => {
    const mapped = mapThreadEventToAgentEvent(
      {
        type: "item.completed",
        item: { type: "context", id: "context-1", text: "" },
      } as any,
      0,
    );
    assert(mapped);
    assert.equal(mapped.phase, "context");
    assert.equal(formatStepTraceLine(mapped), "[context] Context ready\n");
  });

  it("keeps reasoning summaries visible while hiding generic reasoning noise", () => {
    const mapped = mapThreadEventToAgentEvent(
      {
        type: "item.updated",
        item: { type: "reasoning", id: "reasoning-1", text: "Comparing the two implementations", summary: true },
      } as any,
      0,
    );
    assert(mapped);
    assert.equal(formatStepTraceLine(mapped), "[analysis] Reasoning summary: Comparing the two implementations\n");
  });

  it("maps reconnect errors to connection phase", () => {
    const event = {
      type: "error" as const,
      message: "Re-connecting... 3/5",
    };

    const mapped = mapThreadEventToAgentEvent(event, 0);
    assert(mapped);
    assert.equal(mapped.phase, "connection");
    assert.equal(mapped.title, "尝试重连");
    assert.equal(mapped.detail, "3/5");
  });

  it("maps stream disconnect errors to error phase", () => {
    const event = {
      type: "error" as const,
      message: "stream disconnected before completion: stream closed before response.completed",
    };

    const mapped = mapThreadEventToAgentEvent(event, 0);
    assert(mapped);
    assert.equal(mapped.phase, "error");
    assert.equal(mapped.title, "流连接断开");
  });

  it("returns null for non-actionable updates", () => {
    const event = {
      type: "item.updated" as const,
      item: {
        id: "file-1",
        type: "file_change" as const,
        changes: [],
        status: "completed" as const,
      },
    };

    const mapped = mapThreadEventToAgentEvent(event, 0);
    assert.equal(mapped, null);
  });
});
