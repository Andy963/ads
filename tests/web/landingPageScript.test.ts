import { describe, it } from "node:test";
import assert from "node:assert";

import { renderLandingPageScript } from "../../src/web/landingPage/script.js";

describe("web/landingPage/script", () => {
  it("encodes auth token as a protocol-safe subprotocol", () => {
    const script = renderLandingPageScript(15, true);
    assert.ok(script.includes("ads-token."));
    assert.ok(script.includes("ads-session."));
    assert.ok(script.includes("ads-v1"));
  });

  it("avoids updating global session UI for background sessions", () => {
    const script = renderLandingPageScript(15, true);
    assert.ok(script.includes("const activeSessionId = currentSessionId;"));
    assert.ok(script.includes("const isActiveSession = !activeSessionId || sessionId === activeSessionId;"));
    assert.ok(script.includes("if (isActiveSession && msg.sessionId) {"));
    assert.ok(script.includes("if (isActiveSession) {"));
  });

  it("does not overwrite active session storage on background reconnect", () => {
    const script = renderLandingPageScript(15, true);
    assert.ok(script.includes("const shouldPersistSession = !activeId || sessionIdToUse === activeId;"));
    assert.ok(script.includes("if (shouldPersistSession) {"));
    assert.ok(script.includes("saveSession(sessionIdToUse);"));
  });
});
