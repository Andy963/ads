import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveLegacyWebUserId, deriveWebUserId } from "../../server/web/utils.js";
import { buildWsConnectionIdentity } from "../../server/web/server/ws/connectionIdentity.js";

describe("web/ws/connectionIdentity", () => {
  it("builds stable websocket connection identity fields from auth/session inputs", () => {
    const identity = buildWsConnectionIdentity({
      authUserId: "user-a",
      sessionId: "session-1",
      chatSessionId: "main",
      randomHex: () => "abc123",
    });

    assert.deepEqual(identity, {
      authUserId: "user-a",
      chatKey: "session-1:main",
      legacyUserId: deriveLegacyWebUserId("user-a", "session-1:main"),
      userId: deriveWebUserId("user-a", "session-1:main"),
      historyKey: "user-a::session-1::main",
      connectionId: "abc123",
      cacheKey: "user-a::session-1",
      clientMeta: {
        historyKey: "user-a::session-1::main",
        sessionId: "session-1",
        chatSessionId: "main",
        connectionId: "abc123",
        authUserId: "user-a",
        sessionUserId: deriveWebUserId("user-a", "session-1:main"),
      },
    });
  });
});
