# Design

## 根因分析

`ClaudeStreamParser.parseResult()` 以 `subtype === "success"` 作为成功条件，并直接产出 `turn.completed`，没有检查同一 payload 是否包含明确的失败信息字段（`error` / `reason` / `message`）。当 Claude CLI 在失败场景仍输出 `subtype: "success"` 但携带 `error: {...}` 时，就会被误判为成功。

同时，失败分支对错误信息的提取仅考虑 `error`/`result` 为 string，无法抽取 `error.message` 这类嵌套结构，导致 UI 只能看到通用的默认错误文案。

## 方案

- 在 `subtype === "success"` 分支中增加 `hasError` 检测：若存在非空的 `error`（string 或 object）、`reason`、`message`，则转为失败并产出 `turn.failed`。
- 统一错误信息抽取：新增小 helper，从 `error` / `reason` / `message` / `result` 中按优先级抽取，并支持 `error.message` / `error.details` 等嵌套字段。

## 风险与权衡

- 误判风险：如果未来 Claude CLI 在成功 payload 中携带 `error: {}` 这类无意义字段，可能导致误判失败。为降低风险，检测规则仅对 `error` 为非 null object 或非空 string 生效，并优先抽取 `message`/`details` 等字段作为错误 message。
- 兼容性：不改变既有 `subtype !== "success"` 的处理，仍按失败；成功且无 error 信息的场景仍完成。

