# Design: reasoning effort plumbing

## 总览

实现采用“每次 prompt 都携带配置”的数据流：

1. Web UI 在 chat composer 中选择 `reasoningEffort`（`default|low|medium|high|xhigh`）。
2. 前端将其存入当前 `ProjectRuntime`（Worker / Planner 各自维护），并在 WS `prompt` payload 中附带 `model_reasoning_effort` 字段。
3. 后端 `handlePromptMessage()` 在构造 `effectiveInput` 之前读取该字段，调用 `orchestrator.setModelReasoningEffort()`。
4. `HybridOrchestrator` 广播到 active adapter；`CodexCliAdapter` 在 spawn 参数中追加 `--config model_reasoning_effort="..."`。

该设计避免引入新的 REST API，并确保对同一 session 的每次 turn 都可显式指定 effort。

## 数据模型

### WS prompt payload

在现有 `{ text, images }` payload 基础上，增加可选字段：

- `model_reasoning_effort?: string`

该字段仅对 `codex` adapter 有意义，其它 adapter 允许忽略。

### Runtime state

在 `ProjectRuntime` 增加一个字符串状态：

- `modelReasoningEffort: Ref<string>`

取值为预置值之一或 `default`（表示不覆盖）。

### Adapter API

扩展 `AgentAdapter`（可选方法）：

- `setModelReasoningEffort?(effort?: string): void`

并在 `HybridOrchestrator` 增加同名方法，负责广播给 adapters。

## 校验策略

服务端对 `model_reasoning_effort` 做轻量校验：

- 允许 `low|medium|high|xhigh`
- 允许空 / `default`（视为 unset）
- 其它值丢弃（不透传）

这样可以满足当前需求并降低将任意字符串注入到 CLI 参数的风险。

## 兼容性

- 不修改 DB schema。
- WS schema 不需要改动（当前只校验 `type` 字段）。
- 旧版前端不发送该字段时，行为不变。

