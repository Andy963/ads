import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTelegramCodexStatusUpdater } from "../../src/telegram/adapters/codex/statusUpdater.js";
import type { AgentEvent } from "../../src/codex/events.js";

function createCommandEvent(params: {
  id: string;
  command: string;
  status?: string;
  exitCode?: number;
  rawType?: "item.started" | "item.updated" | "item.completed";
}): AgentEvent {
  const { id, command, status, exitCode, rawType } = params;
  return {
    phase: "command",
    title: "执行命令",
    detail: command,
    timestamp: Date.now(),
    raw: {
      type: rawType ?? "item.started",
      item: {
        type: "command_execution",
        id,
        command,
        status,
        exit_code: exitCode,
      },
    },
  } as AgentEvent;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("telegram statusUpdater", () => {
  it("keeps only the last three commands in the status message", async () => {
    const edits: Array<{ messageId: number; text: string }> = [];
    const deletes: Array<{ messageId: number }> = [];

    let nextMessageId = 1000;
    const ctx = {
      reply: async (text: string) => {
        const message_id = nextMessageId++;
        return { message_id, text };
      },
      api: {
        editMessageText: async (_chatId: number, messageId: number, text: string) => {
          edits.push({ messageId, text });
          return true;
        },
        deleteMessage: async (_chatId: number, messageId: number) => {
          deletes.push({ messageId });
          return true;
        },
        sendChatAction: async () => true,
      },
    } as unknown as Parameters<typeof createTelegramCodexStatusUpdater>[0]["ctx"];

    const updater = await createTelegramCodexStatusUpdater({
      ctx,
      chatId: 1,
      activeAgentLabel: "Codex",
      silentNotifications: true,
      streamUpdateIntervalMs: 0,
      isActiveRequest: () => true,
      logWarning: () => {},
    });

    updater.queueEvent(createCommandEvent({ id: "c1", command: "cmd1" }));
    updater.queueEvent(createCommandEvent({ id: "c2", command: "cmd2" }));
    updater.queueEvent(createCommandEvent({ id: "c3", command: "cmd3" }));
    updater.queueEvent(createCommandEvent({ id: "c4", command: "cmd4" }));

    await flush();

    assert.ok(edits.length > 0);
    const last = edits.at(-1)?.text ?? "";
    assert.ok(last.includes("cmd2"));
    assert.ok(last.includes("cmd3"));
    assert.ok(last.includes("cmd4"));
    assert.equal(last.includes("cmd1"), false);

    await updater.finalize();
    await flush();

    const finalized = edits.at(-1)?.text ?? "";
    assert.equal(finalized.includes("最近命令"), false);
    assert.equal(finalized.includes("cmd4"), false);

    await updater.cleanup();
    assert.deepEqual(deletes, [{ messageId: 1000 }]);
  });

  it("updates an existing command entry by id", async () => {
    const edits: Array<{ text: string }> = [];

    let nextMessageId = 2000;
    const ctx = {
      reply: async (text: string) => {
        const message_id = nextMessageId++;
        return { message_id, text };
      },
      api: {
        editMessageText: async (_chatId: number, _messageId: number, text: string) => {
          edits.push({ text });
          return true;
        },
        deleteMessage: async () => true,
        sendChatAction: async () => true,
      },
    } as unknown as Parameters<typeof createTelegramCodexStatusUpdater>[0]["ctx"];

    const updater = await createTelegramCodexStatusUpdater({
      ctx,
      chatId: 1,
      activeAgentLabel: "Codex",
      silentNotifications: true,
      streamUpdateIntervalMs: 0,
      isActiveRequest: () => true,
      logWarning: () => {},
    });

    updater.queueEvent(createCommandEvent({ id: "c1", command: "cmd1", status: "running", rawType: "item.started" }));
    updater.queueEvent(createCommandEvent({ id: "c1", command: "cmd1", status: "completed", exitCode: 0, rawType: "item.completed" }));

    await flush();

    const last = edits.at(-1)?.text ?? "";
    assert.ok(last.includes("cmd1"));
    assert.ok(last.includes("exit 0"));
    assert.equal((last.match(/cmd1/g) ?? []).length, 1);

    await updater.cleanup();
  });
});

