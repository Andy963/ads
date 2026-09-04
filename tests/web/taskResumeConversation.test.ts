import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildHistoryStoreResumeTranscript } from "../../server/web/server/ws/taskResumeConversation.js";

describe("web/ws/taskResumeConversation", () => {
  it("builds a bounded transcript from the active lane history", () => {
    const transcript = buildHistoryStoreResumeTranscript([
      { role: "status", text: "old status", ts: 1 },
      { role: "user", text: "first question", ts: 2 },
      { role: "ai", text: "first answer", ts: 3 },
      { role: "status", kind: "session_divider", text: "new session", ts: 4 },
      { role: "user", text: "current question", ts: 5 },
      { role: "ai", text: "current answer", ts: 6 },
    ]);

    assert.equal(transcript, "User: current question\nAssistant: current answer");
  });

  it("truncates from the front without consulting task storage", () => {
    const transcript = buildHistoryStoreResumeTranscript([
      { role: "user", text: "first", ts: 1 },
      { role: "ai", text: "second", ts: 2 },
    ], 10);

    assert.equal(transcript, "nt: second");
  });
});
