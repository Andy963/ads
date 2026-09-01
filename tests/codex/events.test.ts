import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mapThreadEventToAgentEvent } from "../../server/codex/events.js";

describe("mapThreadEventToAgentEvent", () => {
  it("maps turn.started to analysis phase", () => {
    const event = { type: "turn.started" } as const;
    const mapped = mapThreadEventToAgentEvent(event, 0);
    assert(mapped);
    assert.equal(mapped.phase, "analysis");
    assert.equal(mapped.title, "开始处理请求");
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
