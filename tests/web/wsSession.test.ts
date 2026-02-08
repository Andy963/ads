import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveProjectSessionId } from "../../src/web/server/projectSessionId.js";
import { matchesBroadcastSessionId, parseWsSessionFromProtocols, resolveWebSocketSessionId } from "../../src/web/server/ws/session.js";

describe("web/server/ws/session", () => {
  it("parses session token from websocket protocols", () => {
    assert.equal(parseWsSessionFromProtocols(["ads-v1", "ads-session.abc"]), "abc");
    assert.equal(parseWsSessionFromProtocols(["ads-session:xyz"]), "xyz");
    assert.equal(parseWsSessionFromProtocols(["ads-session", "next"]), "next");
    assert.equal(parseWsSessionFromProtocols(["ads-v1"]), null);
  });

  it("maps ads-session.default to derived project session id", () => {
    const workspaceRoot = "/tmp/example-workspace";
    const expected = deriveProjectSessionId(workspaceRoot);
    const resolved = resolveWebSocketSessionId({ protocols: ["ads-v1", "ads-session.default"], workspaceRoot });
    assert.equal(resolved, expected);
  });

  it("keeps non-default session ids unchanged", () => {
    const resolved = resolveWebSocketSessionId({ protocols: ["ads-v1", "ads-session.custom"], workspaceRoot: "/tmp/w" });
    assert.equal(resolved, "custom");
  });

  it("matches broadcast session by either connection session id or workspace root", () => {
    const workspaceRoot = "/tmp/example-workspace";
    const broadcastSessionId = deriveProjectSessionId(workspaceRoot);

    assert.equal(
      matchesBroadcastSessionId({ broadcastSessionId, connectionSessionId: broadcastSessionId, connectionWorkspaceRoot: null }),
      true,
    );
    assert.equal(
      matchesBroadcastSessionId({ broadcastSessionId, connectionSessionId: "other", connectionWorkspaceRoot: workspaceRoot }),
      true,
    );
    assert.equal(
      matchesBroadcastSessionId({ broadcastSessionId, connectionSessionId: "other", connectionWorkspaceRoot: "/tmp/another" }),
      false,
    );
  });
});
