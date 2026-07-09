import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handlePromptError } from "../../server/web/server/ws/promptErrorHandling.js";
import { HistoryStore } from "../../server/utils/historyStore.js";

describe("web/ws/promptErrorHandling", () => {
  it("sends abort message when the signal was aborted", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-error", maxEntriesPerSession: 20 });

    try {
      handlePromptError({
        error: new Error("some error"),
        aborted: true,
        sessionLogger: null,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        historyStore,
        historyKey: "h1",
        sendToChat: (payload) => sent.push(payload),
      });

      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], { type: "error", message: "已中断，输出可能不完整" });
      assert.deepEqual(
        historyStore.get("h1").map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
        [{ role: "status", text: "已中断，输出可能不完整", kind: "error" }],
      );
    } finally {
      historyStore.clear("h1");
    }
  });

  it("classifies and broadcasts unknown errors with default log prefix", () => {
    const sent: unknown[] = [];
    const warnings: string[] = [];
    const historyStore = new HistoryStore({ namespace: "test-error-2", maxEntriesPerSession: 20 });

    try {
      handlePromptError({
        error: new Error("something went wrong"),
        aborted: false,
        sessionLogger: null,
        logger: { info: () => {}, warn: (msg: string) => warnings.push(msg), debug: () => {} },
        historyStore,
        historyKey: "h2",
        sendToChat: (payload) => sent.push(payload),
      });

      assert.equal(sent.length, 1);
      const result = sent[0] as Record<string, unknown>;
      assert.equal(result.type, "error");
      assert.ok(typeof result.message === "string" && result.message.length > 0);
      assert.ok(result.errorInfo !== undefined, "expected errorInfo in result");

      const errorInfo = result.errorInfo as Record<string, unknown>;
      assert.equal(errorInfo.code, "unknown");
      assert.equal(errorInfo.retryable, true);
      assert.equal(errorInfo.needsReset, false);

      // Should record to history
      const entries = historyStore.get("h2");
      assert.equal(entries.length, 1);
      assert.equal(entries[0].role, "status");
      assert.equal(entries[0].kind, "error");

      // Should warn with default prefix
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes("[Prompt Error]"), `expected [Prompt Error] prefix, got: ${warnings[0]}`);
    } finally {
      historyStore.clear("h2");
    }
  });

  it("supports custom log prefix", () => {
    const warnings: string[] = [];
    const historyStore = new HistoryStore({ namespace: "test-error-3", maxEntriesPerSession: 20 });

    try {
      handlePromptError({
        error: new Error("fail"),
        aborted: false,
        sessionLogger: null,
        logger: { info: () => {}, warn: (msg: string) => warnings.push(msg), debug: () => {} },
        historyStore,
        historyKey: "h3",
        sendToChat: () => {},
        logPrefix: "Custom Prompt Error",
      });

      assert.equal(warnings.length, 1);
      assert.ok(
        warnings[0].includes("[Custom Prompt Error]"),
        `expected [Custom Prompt Error] prefix, got: ${warnings[0]}`,
      );
    } finally {
      historyStore.clear("h3");
    }
  });

  it("classifies rate-limit errors correctly", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-error-4", maxEntriesPerSession: 20 });

    try {
      handlePromptError({
        error: new Error("429 Too Many Requests - rate limit exceeded"),
        aborted: false,
        sessionLogger: null,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        historyStore,
        historyKey: "h4",
        sendToChat: (payload) => sent.push(payload),
      });

      const result = sent[0] as Record<string, unknown>;
      const errorInfo = result.errorInfo as Record<string, unknown>;
      assert.equal(errorInfo.code, "rate_limit");
      assert.equal(errorInfo.retryable, true);
      assert.equal(errorInfo.originalError, undefined);
    } finally {
      historyStore.clear("h4");
    }
  });

  it("does not broadcast raw Claude JSONL details to chat", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-error-jsonl", maxEntriesPerSession: 20 });
    const rawClaudeOutput = [
      '{"type":"system","subtype":"init","session_id":"sid"}',
      '{"type":"system","subtype":"api_retry","attempt":10,"max_retries":10,"error_status":429,"error":"rate_limit"}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"API Error: Request rejected (429) · Service Unavailable"}',
    ].join("\n");

    try {
      handlePromptError({
        error: new Error(rawClaudeOutput),
        aborted: false,
        sessionLogger: null,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        historyStore,
        historyKey: "h-jsonl",
        sendToChat: (payload) => sent.push(payload),
      });

      const result = sent[0] as Record<string, unknown>;
      assert.equal(result.message, "API 请求频率过高，请稍后重试");
      const errorInfo = result.errorInfo as Record<string, unknown>;
      assert.equal(errorInfo.code, "rate_limit");
      assert.equal(errorInfo.originalError, undefined);
    } finally {
      historyStore.clear("h-jsonl");
    }
  });

  it("logs error with stack trace when session logger is available", () => {
    const logged: string[] = [];
    const historyStore = new HistoryStore({ namespace: "test-error-5", maxEntriesPerSession: 20 });
    const sessionLogger = {
      logInput: () => {},
      logOutput: () => {},
      logError: (text: string) => logged.push(text),
      logEvent: () => {},
      attachThreadId: () => {},
    };

    try {
      const err = new Error("test error with stack");
      handlePromptError({
        error: err,
        aborted: false,
        sessionLogger,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        historyStore,
        historyKey: "h5",
        sendToChat: () => {},
      });

      assert.equal(logged.length, 1);
      assert.ok(logged[0].includes("[unknown]"), "expected error code in log");
      assert.ok(logged[0].includes("test error with stack"), "expected error message in log");
      // Should include stack trace
      assert.ok(logged[0].includes("\n"), "expected stack trace newline");
    } finally {
      historyStore.clear("h5");
    }
  });
});
