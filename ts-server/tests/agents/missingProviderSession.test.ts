import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createProviderSessionFallbackEvent,
  isMissingProviderSessionError,
} from "../../server/agents/adapters/missingProviderSession.js";

describe("agents/missingProviderSession", () => {
  it("recognises the verbatim errors both CLIs emit for a deleted session", () => {
    // Captured by resuming a well-formed but non-existent id against each CLI.
    assert.equal(
      isMissingProviderSessionError(
        "thread/resume: thread/resume failed: no rollout found for thread id " +
          "00000000-0000-4000-8000-000000000000 (code -32600)",
      ),
      true,
    );
    assert.equal(
      isMissingProviderSessionError(
        "No conversation found with session ID: 00000000-0000-4000-8000-000000000000",
      ),
      true,
    );
  });

  it("recognises generic not-found phrasings for a thread or session", () => {
    assert.equal(isMissingProviderSessionError("Error: thread not found"), true);
    assert.equal(isMissingProviderSessionError("session ID not found on disk"), true);
    assert.equal(isMissingProviderSessionError("not found: conversation abc"), true);
  });

  it("does not absorb failures that must keep the saved id", () => {
    // Absorbing any of these would silently start a fresh thread and lose the
    // conversation for a reason that would have resolved on the next attempt.
    assert.equal(isMissingProviderSessionError(""), false);
    assert.equal(isMissingProviderSessionError("   "), false);
    assert.equal(isMissingProviderSessionError("upstream connection error"), false);
    assert.equal(isMissingProviderSessionError("529 overloaded, please retry"), false);
    assert.equal(
      isMissingProviderSessionError("thread was created with model opus; requested sonnet"),
      false,
    );
    assert.equal(isMissingProviderSessionError("file not found: /tmp/image.png"), false);
    assert.equal(isMissingProviderSessionError("command not found: rg"), false);
  });

  it("marks the fallback event so the transport can flag the next turn", () => {
    const event = createProviderSessionFallbackEvent({
      agentName: "Codex CLI",
      previousSessionId: "thread-abc",
      message: "no rollout found for thread id thread-abc",
    });

    assert.equal(event.sessionFallback?.reason, "missing_provider_session");
    assert.equal(event.sessionFallback?.previousSessionId, "thread-abc");
    assert.match(String(event.detail), /thread-abc/);
    // Not a retry: the turn is not being reattempted against the same thread.
    assert.equal(event.retry, undefined);
  });
});
