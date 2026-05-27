import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applySessionOverrides } from "../../server/web/server/ws/sessionOverrides.js";

describe("web/sessionOverrides", () => {
  it("rotates the session model and returns a user notice when model changes", () => {
    const calls: Array<{ type: string; value?: string }> = [];
    const sessionManager = {
      switchAgent: (_userId: number, value: string) => {
        calls.push({ type: "agent", value });
        return { success: true, message: "ok" };
      },
      getUserModel: () => "gpt-4.1",
      getOrCreate: () => ({ setModelConfig: () => {} }),
      setUserModel: (_userId: number, value?: string) => {
        calls.push({ type: "model", value });
      },
      setUserModelReasoningEffort: (_userId: number, value?: string) => {
        calls.push({ type: "effort", value });
      },
    };

    const result = applySessionOverrides({
      sessionManager: sessionManager as any,
      userId: 7,
      payload: {
        model: "gpt-4o",
        modelReasoningEffort: "high",
      },
    });

    assert.equal(result.notice, "模型已从 gpt-4.1 切换到 gpt-4o，已启动新会话线程。");
    assert.deepEqual(calls, [
      { type: "model", value: "gpt-4o" },
      { type: "effort", value: "high" },
    ]);
  });

  it("does not re-announce unchanged models but still applies reasoning overrides", () => {
    const calls: Array<{ type: string; value?: string }> = [];
    const sessionManager = {
      switchAgent: (_userId: number, value: string) => {
        calls.push({ type: "agent", value });
        return { success: true, message: "ok" };
      },
      getUserModel: () => "gpt-4o",
      getOrCreate: () => ({ setModelConfig: () => {} }),
      setUserModel: (_userId: number, value?: string) => {
        calls.push({ type: "model", value });
      },
      setUserModelReasoningEffort: (_userId: number, value?: string) => {
        calls.push({ type: "effort", value });
      },
    };

    const result = applySessionOverrides({
      sessionManager: sessionManager as any,
      userId: 7,
      payload: {
        model: "gpt-4o",
        modelReasoningEffort: "default",
      },
    });

    assert.equal(result.notice, undefined);
    assert.deepEqual(calls, [{ type: "effort", value: undefined }]);
  });

  it("ignores payloads without session override fields", () => {
    const calls: Array<{ type: string; value?: string }> = [];
    const sessionManager = {
      switchAgent: (_userId: number, value: string) => {
        calls.push({ type: "agent", value });
        return { success: true, message: "ok" };
      },
      getUserModel: () => "gpt-4o",
      getOrCreate: () => ({ setModelConfig: () => {} }),
      setUserModel: (_userId: number, value?: string) => {
        calls.push({ type: "model", value });
      },
      setUserModelReasoningEffort: (_userId: number, value?: string) => {
        calls.push({ type: "effort", value });
      },
    };

    const result = applySessionOverrides({
      sessionManager: sessionManager as any,
      userId: 7,
      payload: { text: "hello" },
    });

    assert.equal(result.notice, undefined);
    assert.deepEqual(calls, []);
  });

  it("applies the prompt agent override before execution", () => {
    const calls: Array<{ type: string; value?: string }> = [];
    const sessionManager = {
      switchAgent: (_userId: number, value: string) => {
        calls.push({ type: "agent", value });
        return { success: true, message: "ok" };
      },
      getUserModel: () => "gpt-4o",
      getOrCreate: () => ({ setModelConfig: () => {} }),
      setUserModel: (_userId: number, value?: string) => {
        calls.push({ type: "model", value });
      },
      setUserModelReasoningEffort: (_userId: number, value?: string) => {
        calls.push({ type: "effort", value });
      },
    };

    const result = applySessionOverrides({
      sessionManager: sessionManager as any,
      userId: 7,
      payload: {
        agentId: "claude",
        modelReasoningEffort: "high",
      },
    });

    assert.equal(result.notice, undefined);
    assert.deepEqual(calls, [
      { type: "agent", value: "claude" },
      { type: "effort", value: "high" },
    ]);
  });

  it("rejects unknown prompt agent overrides", () => {
    const sessionManager = {
      switchAgent: (_userId: number, value: string) => ({
        success: false,
        message: `Agent "${value}" is not registered`,
      }),
      getUserModel: () => "gpt-4o",
      getOrCreate: () => ({ setModelConfig: () => {} }),
      setUserModel: () => {},
      setUserModelReasoningEffort: () => {},
    };

    assert.throws(
      () =>
        applySessionOverrides({
          sessionManager: sessionManager as any,
          userId: 7,
          payload: {
            agentId: "missing",
          },
        }),
      /Agent "missing" is not registered/,
    );
  });
});
