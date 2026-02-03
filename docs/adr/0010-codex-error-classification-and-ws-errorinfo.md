# ADR-0010: Codex Error Classification and WS `errorInfo` Propagation

- Status: Accepted
- Date: 2026-02-03

## Context

当前 Codex 对话执行链路（Codex session -> WebSocket -> Web UI）在异常场景下主要依赖原始错误字符串：

- 同类错误在不同入口/不同栈层产生的文案不一致，用户难以判断应当“重试”还是“/reset”；
- 服务端日志缺少结构化字段，排查时难以做聚合统计（例如 rate limit / timeout / token limit）；
- Web UI 只能展示一行错误提示，无法表达“是否可重试 / 是否需要 reset”等操作建议。

需要一个低侵入、可演进的方式把错误归一化，并将“用户提示 + 操作建议”透传到 Web UI。

## Decision

1. 增加统一的错误分类函数 `classifyError(error)`：
   - 输出结构化 `CodexErrorInfo`（`code/userHint/retryable/needsReset` 等）。
   - 采用“可扩展的 pattern 列表”匹配常见错误（rate limit / token limit / timeout / auth 等），未命中则归为 `unknown`。

2. 在 Codex 执行链路中使用 `CodexClassifiedError` 包装错误：
   - 统一在捕获点做分类与日志记录。
   - 上层逻辑（例如是否建议 reset）优先读取 `CodexClassifiedError.info`，避免重复分类与文案分叉。

3. WebSocket error 消息扩展为可选 `errorInfo`：
   - 服务端在发送 `{ type: "error" }` 时附带 `errorInfo`，包含 `code/retryable/needsReset/originalError`。
   - Web UI 在收到 error 时优先展示 `message=userHint`，并在消息体中补充结构化信息以指导操作。

## Consequences

- 正向：
  - 错误展示更一致，用户可快速判断“重试 vs /reset”；
  - 服务端日志具备 `code` 等字段，便于聚合统计与定位高频错误；
  - 客户端无需解析各种字符串即可获得操作建议（`retryable/needsReset`）。

- 负向/风险：
  - Pattern 匹配可能存在误分类；需要在上线后通过日志反馈持续校准规则。
  - `errorInfo` 是协议扩展字段，需要保证旧客户端忽略该字段时仍能正确展示 `message`。

## Implementation Notes

- 错误分类与 reset 判定：`src/codex/errors.ts`
- Codex session 统一包装与展示：`src/codex/codexChat.ts`
- WebSocket 发送 `errorInfo`：`src/web/server/ws/handlePrompt.ts`
- Web client 消费 `errorInfo`：`web/src/app/projectsWs/wsMessage.ts`

