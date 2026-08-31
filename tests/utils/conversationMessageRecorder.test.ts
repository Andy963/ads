import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  recordConversationMessage,
  setConversationMessageRecorder,
  type ConversationMessage,
} from "../../server/utils/conversationMessageRecorder.js";

const message: ConversationMessage = {
  eventId: "event-1",
  workspaceRoot: "/workspace",
  sessionId: "session-1",
  source: "web",
  role: "user",
  text: "hello",
  agentId: "codex",
};

describe("conversation message recorder", () => {
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
