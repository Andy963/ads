import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "grammy";

import { handleCodexMessage } from "../../server/telegram/adapters/codex.js";
import {
  setConversationMessageRecorder,
  type ConversationMessage,
} from "../../server/utils/conversationMessageRecorder.js";

describe("telegram conversation message recorder", () => {
  const originalStatusUpdates = process.env.ADS_TELEGRAM_STATUS_UPDATES;

  beforeEach(() => {
    process.env.ADS_TELEGRAM_STATUS_UPDATES = "false";
  });

  afterEach(() => {
    setConversationMessageRecorder(null);
    if (originalStatusUpdates === undefined) delete process.env.ADS_TELEGRAM_STATUS_UPDATES;
    else process.env.ADS_TELEGRAM_STATUS_UPDATES = originalStatusUpdates;
  });

  it("publishes accepted user input and the delivered final reply", async () => {
    const recorded: ConversationMessage[] = [];
    const replies: string[] = [];
    setConversationMessageRecorder({ record: (message) => recorded.push(message) });

    const session = {
      getThreadId: () => "thread-1",
      getActiveAgentId: () => "codex",
      onEvent: () => () => undefined,
      async send() { return { response: "Final answer" }; },
    };
    const sessionManager = {
      getOrCreate: () => session,
      saveThreadId: () => undefined,
      reset: () => undefined,
    };
    const ctx = {
      from: { id: 7 },
      chat: { id: 42 },
      message: { message_id: 99 },
      update: { update_id: 123 },
      api: { sendChatAction: async () => true },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: replies.length };
      },
    } as unknown as Context;

    await handleCodexMessage(ctx, "User prompt", sessionManager as never, 0, undefined, undefined, process.cwd());

    assert.equal(replies.length, 1);
    assert.deepEqual(recorded.map(({ eventId, source, role, text, sessionId }) => ({ eventId, source, role, text, sessionId })), [
      { eventId: "telegram:42:99:user", source: "telegram", role: "user", text: "User prompt", sessionId: "thread-1" },
      { eventId: "telegram:42:99:assistant", source: "telegram", role: "assistant", text: "Final answer", sessionId: "thread-1" },
    ]);
  });
});
