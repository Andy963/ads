# ADR 0024: Define Native Provider Capability Contracts

## Status

Accepted

## Context

Native Runtime 与 Codex app-server 共享 `AgentAdapter` 的 turn 选项，但两者
的 provider 能力并不相同。Native adapter 曾把 streaming 固定为 true、在
non-streaming response 中触发 delta callback，并静默忽略 reasoning effort 和
output schema。这样会让调用方误以为某个能力已经成功执行。

## Decision

1. Native provider capability 使用 `supported`、`unsupported` 和 `unknown` 三态，
   覆盖 streaming、non-streaming、tool calls、parallel tool calls、image input、
   structured output、reasoning effort、usage、context metadata 和 provider-specific
   options。
2. Native 默认实现明确声明 streaming、non-streaming、tool calls、parallel tool
   calls、usage 和 context metadata；image input 明确 unsupported；structured output、
   reasoning effort 和 provider-specific options 在没有 provider 配置时为 unknown。
3. 模型配置可以覆盖 provider capability。请求显式使用 unknown/unsupported 能力时，
   在发出 provider 请求前返回带 `NATIVE_CAPABILITY_UNSUPPORTED` code 的 capability
   error，不进行静默降级。
4. `streaming: false` 发送非流式 Chat Completions 请求，不注册 text delta callback，
   不产生 partial assistant snapshot；非流式 response 必须包含合法的 choices/message，
   usage 继续使用统一解析逻辑。
5. structured output 只有在 provider capability 明确为 supported 时才发送
   `response_format`；图片输入始终在 provider 执行前拒绝。tool calls、最终 assistant
   message、usage、command 和 file-change 事件继续使用共享 AgentEvent 契约。
6. 本契约只描述 Native provider 能力，不改变 Codex app-server 的 RPC 能力，也不
   允许跨 runtime resume。

## Consequences

- 调用方可以区分“provider 不支持”和“配置未知”，不会把被忽略的参数误认为已执行。
- 非流式、structured output 和 reasoning 的行为需要 provider/model 配置明确声明，
  这是为了避免向不兼容 provider 发送静默无效的参数。
- capability metadata 是内部运行时契约，不改变公开 logical agent id，也不把 Native
  execution id 暴露为 Codex provider thread。
