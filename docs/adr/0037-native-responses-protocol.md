# ADR 0037: Native Runtime 同时支持 Responses 与 Chat Completions

## Status

Accepted

## Context

Native 第一阶段只实现 Chat Completions，而服务商配置已允许并默认选择 Responses。
配置能力与执行能力不一致，使 Native 在模型解析时直接拒绝 Responses 服务商。
Responses 使用 typed output items 和 SSE events，其工具调用、reasoning 连续性和结束
状态不能仅通过替换 Chat URL 正确适配。

## Decision

1. 由保存的服务商 `wireApi` 显式决定协议。`chat` 与 `responses` 分别进入独立客户端，
   未设置保持旧 Chat 行为；未知协议在请求前拒绝，绝不静默切换端点重发密钥。
2. 保持已有 AgentEvent、工具执行器、取消、重试与安全检查契约。Responses 客户端将
   output items 归一化为文本、工具调用及 usage；工具结果按 `call_id` 关联，而非 item id。
3. Responses 使用 `store: false` 和显式完整上下文，不依赖 `previous_response_id` 或
   provider conversation。请求兼容携带 `include: ["reasoning.encrypted_content"]`。
   output items（含 encrypted reasoning 和 assistant phase）作为 assistant 消息的
   可选内部元数据保存，在同模型、同端点、同凭据下按原顺序回传。
4. 元数据作用域使用上述连接信息的摘要，不保存明文密钥。切换模型、端点、凭据或进入
   Chat 路径时，仅使用已有规范消息与工具证据，不向另一连接回放 provider opaque data。
   可选 JSON 元数据复用 transcript 的脱敏与 writer fencing，不改变数据库 schema；
   只有 typed reasoning 的 opaque ciphertext 避免启发式文本替换，已知凭据仍须脱敏，
   可读文本、summary 与工具参数不享有此例外。
   不向 UI、日志或公共 Chat payload 暴露这些内部字段。
5. reasoning 元数据作为不可分消息开销参与 context projection。仅截断工具结果，不
   截断 encrypted reasoning；完整 turn 可以按现有规则淘汰。中断后的 tool call/result
   配对及任务锚点继续遵守 ADR 0036，不重放已执行工具。
6. 流式文本通过 typed delta 更新，只有有效终止事件才能提交完整响应及执行工具。
   不完整工具调用、相互矛盾的流式与终态信息、孤立结束标记及未知工具类型必须失败，
   不能被当成成功或导致副作用。reasoning 不作为可见文本流输出。
7. 预算沿用 ADR 0023；统一输出上限分别映射为 Chat `max_tokens` 和 Responses
   `max_output_tokens`。Reviewer 使用同一协议分发，保留其只读、有界检查边界。

## Consequences

- Native 可使用显式选择的 Responses 服务商，同时保持已有 Chat 部署兼容。
- 这是 text/image、function tools、structured output 和 usage 的协议支持，不隐式开放
  provider 托管工具、后台任务或任意远程 MCP；这些能力需要另行设计授权和生命周期。
- 本地恢复不依赖 provider 存储。opaque reasoning 仍受已知凭据脱敏约束，
  服务商必须返回可用于 stateless replay 的有效 output items。
- 协议解析需覆盖 SSE 分片、截断、失败、取消、工具关联及持久化恢复；不能以普通文本
  请求成功代替完整 agent 工具循环验证。

## References

- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://developers.openai.com/api/docs/guides/function-calling
- https://developers.openai.com/api/docs/guides/reasoning
- https://developers.openai.com/api/docs/guides/streaming-responses
