import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyError } from "../../server/codex/errors.js";

describe("classifyError", () => {
  // Each sample is a real message seen surfacing as `unknown` in production logs.
  const cases: Array<{ name: string; input: string; code: string; retryable: boolean; needsReset: boolean }> = [
    {
      name: "server overload / high demand",
      input: "We're currently experiencing high demand, which may cause temporary errors.",
      code: "server_overloaded",
      retryable: true,
      needsReset: false,
    },
    {
      name: "model at capacity is overload, not a mismatch",
      input: "Selected model is at capacity. Please try a different model.",
      code: "server_overloaded",
      retryable: true,
      needsReset: false,
    },
    {
      name: "usage limit",
      input:
        "You've hit your usage limit. To get more access now, send a request to your admin or try again at 4:17 PM.",
      code: "usage_limit",
      retryable: true,
      needsReset: false,
    },
    {
      name: "ADS CLI run timeout notice",
      input: "[ads] CLI 运行超过 1800000ms 超时，子进程已被终止。",
      code: "run_timeout",
      retryable: true,
      needsReset: false,
    },
    {
      name: "ADS CLI idle timeout notice",
      input: "[ads] CLI 连续 3600000ms 无输出，已按空闲超时终止子进程。",
      code: "run_idle_timeout",
      retryable: true,
      needsReset: false,
    },
    {
      name: "ADS CLI maximum runtime notice",
      input: "[ads] CLI 运行超过最大时长 43200000ms，子进程已被终止。",
      code: "run_max_timeout",
      retryable: true,
      needsReset: false,
    },
    {
      name: "invalid codex request",
      input:
        '{"error":{"message":"invalid codex request (request id: 20260710150815216978944MuuDm9hE)","type":"new_api_error","param":"","code":"invalid_responses_request"}}',
      code: "bad_request",
      retryable: true,
      needsReset: false,
    },
    {
      name: "bad response status code 400 wrapper",
      input:
        '[unknown] 发生未知错误，请重试或使用 /reset 重置会话 详情：{"error":{"message":"bad response status code 400 (request id: 20260724173223588236521hVuAx2Aj)","type":"bad_response_status_code","param":"","code":"bad_response_status_code"}}',
      code: "bad_request",
      retryable: true,
      needsReset: false,
    },
    {
      name: "internal server error",
      input: '{"error":{"message":"Internal server error"}}',
      code: "server_error",
      retryable: true,
      needsReset: false,
    },
    {
      name: "5xx unexpected status",
      input: "unexpected status 521 <unknown status code>: Unknown error, url: https://anyrouter.top/v1/responses",
      code: "server_error",
      retryable: true,
      needsReset: false,
    },
    {
      name: "model not supported (Chinese)",
      input:
        'unexpected status 404 Not Found: {"error":"当前 API 不支持所选模型 gpt-5.6-sol","type":"error"}, url: https://anyrouter.top/v1/responses',
      code: "model_not_supported",
      retryable: false,
      needsReset: false,
    },
    {
      name: "nested Claude session",
      input: "Error: Claude Code cannot be launched inside another Claude Code session.",
      code: "nested_session",
      retryable: false,
      needsReset: false,
    },
    {
      name: "CLI version mismatch (unexpected argument)",
      input: "error: unexpected argument '--dangerously-bypass-approvals-and-sandbox' found",
      code: "cli_version_mismatch",
      retryable: false,
      needsReset: false,
    },
    {
      name: "genuine model mismatch on resume",
      input: "cannot resume thread with a different model",
      code: "model_mismatch",
      retryable: false,
      needsReset: false,
    },
    {
      name: "session id already in use",
      input: "Error: Session ID 2a1c2655-d6c7-4bd0-9700-09692e62cd0a is already in use.",
      code: "session_in_use",
      retryable: true,
      needsReset: false,
    },
    {
      name: "rate limit 429",
      input: "exceeded retry limit, last status: 429 Too Many Requests, request id: xwra8wq5zwo",
      code: "rate_limit",
      retryable: true,
      needsReset: false,
    },
    {
      name: "Fable safeguard rejection",
      input:
        "API Error: Fable 5's safeguards flagged this message. Claude Code can't respond to this request with Fable 5.",
      code: "safeguard_rejected",
      retryable: true,
      needsReset: false,
    },
    {
      name: "HTTP 503 service unavailable",
      input: "API Error: 503 Service Unavailable. This is a server-side issue, usually temporary.",
      code: "server_overloaded",
      retryable: true,
      needsReset: false,
    },
  ];

  for (const c of cases) {
    it(`classifies ${c.name}`, () => {
      const info = classifyError(new Error(c.input));
      assert.equal(info.code, c.code);
      assert.equal(info.retryable, c.retryable);
      assert.equal(info.needsReset, c.needsReset);
    });
  }

  it("keeps thread-corruption reset behavior", () => {
    const info = classifyError(
      new Error("thread has encrypted content that could not be verified"),
    );
    assert.equal(info.code, "thread_corrupted");
    assert.equal(info.needsReset, true);
  });

  it("does not classify generic safeguard policy rejections as the Fable retry case", () => {
    const info = classifyError(
      new Error("The provider safeguards flagged this message as violating its acceptable use policy."),
    );
    assert.equal(info.code, "unknown");
  });

  it("includes a truncated original detail in the unknown hint", () => {
    const info = classifyError(new Error("some totally novel failure mode xyz"));
    assert.equal(info.code, "unknown");
    assert.match(info.userHint, /详情：some totally novel failure mode xyz/);
  });

  it("caps the unknown detail length", () => {
    const long = "z".repeat(500);
    const info = classifyError(new Error(long));
    assert.equal(info.code, "unknown");
    // Hint = prefix + detail; the echoed detail itself must be bounded.
    const detail = info.userHint.split("详情：")[1] ?? "";
    assert.ok(detail.length <= 180, `detail length ${detail.length} exceeds cap`);
  });
});
