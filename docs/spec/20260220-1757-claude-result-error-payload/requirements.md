# Requirements

## 背景

ADS 通过 `ClaudeStreamParser` 解析 `claude` CLI 的 `stream-json` 输出，并将其映射为内部 `ThreadEvent`（例如 `turn.completed` / `turn.failed`）。

当前解析逻辑在遇到 `{"type":"result","subtype":"success", ...}` 时无条件判定为成功，即使 payload 同时包含明确的 `error` 字段（例如 `error: { message: "x" }`）。这会导致 ADS Web/UI 将失败 turn 误显示为完成，与设计预期（只要有明确 error 字段就走失败分支）不一致。

## 目标

- 当 `type: "result"` 且 `subtype: "success"` 时，如果 payload 含有 `error`（含对象）、`reason`、`message` 等显式失败信息，仍应产出 `turn.failed`。
- `turn.failed` 的错误信息应优先抽取 `error.message` 等嵌套字段，避免落到笼统的默认文案。
- 补充回归测试覆盖：`{ type: "result", subtype: "success", error: { message: "x" } }` 应被判定为失败。

## 非目标

- 不改变 Claude CLI 的输出格式或文案。
- 不调整除 `result` 以外的事件映射（例如 tool use/result）。
- 不引入持久化格式、数据库 schema 或公共 API 的变更。

## 约束

- 改动应尽量小、可审阅、可回滚。
- 保持现有成功路径行为不变（没有 error 信息的 `subtype: "success"` 仍然完成）。
- `npm test` 需要通过。

## 验收标准

- `ClaudeStreamParser.parseLine()` 解析回归输入时，事件 phase 为 error，且 `getLastError()` 返回 `"x"`。
- 普通成功 `result`（无 error/reason/message）仍产出 completed。
- `npm test` 通过。

