# ADR 0026: Define the Native Runtime Lifecycle and Capability Contract

## Status

Accepted

## Context

ADS 对外暴露一个逻辑 agent 身份，同时为进程选择一个 runtime backend。公开身份、
runtime backend、execution session、provider session 和 ADS transcript 是不同概念。
把它们混为一谈可能导致 Native execution identity 写入 Codex thread storage、从错误
backend 恢复 transcript，或让调用方误以为所选 provider 实际支持某些能力。

Native runtime 现在已经具备 durable transcript、token-aware context projection、
provider capability negotiation 和 bounded recovery。这些契约需要一个面向运维的统一
边界，在不改变公开 agent 身份和 WebSocket 协议的前提下连接已有 ADR。

## Decision

### Identity and runtime selection

以下身份必须保持彼此独立：

| 身份 | 含义 | 持久化与可见性 |
| --- | --- | --- |
| Logical agent | Web、Actions 和 connector 选择的公开 `codex` agent | 稳定的公开标识 |
| Runtime backend | ADS 进程选择的 `codex-app-server` 或 `native` | 进程级配置；session 内不可切换 |
| Execution session | 一个 user、project 和 lifecycle 对应的内存 adapter/orchestrator 生命周期 | disposal 时释放；不是 provider thread |
| Provider session | Codex provider thread 或 Native request sequence | Codex thread ID 由 provider 持有；Native execution ID 仅存在于进程内 |
| ADS transcript | 按顺序保存的 provider-neutral Native message 和执行 artifact | 只为 completed durable Native turn 保存；绝不导入为 Codex rollout |

`ADS_AGENT_RUNTIME` 在进程启动时解析完成。session 在整个生命周期内绑定该 backend。
持久化 backend 不匹配时必须显式失败；ADS 绝不跨 backend 迁移、恢复或静默注入上下文。
Native execution ID 绝不写入 Codex thread storage、history session link 或 Codex provider
request。

### Lifecycle and recovery

普通 Web 和 Actions Developer session 使用 `durable` lifecycle。Native durable session
在 ADS state store 中按顺序 checkpoint message 和 tool artifact。只有 `completed` turn
可以恢复。进程中断时，残留的 `running` turn 会标记为 `interrupted`；failed、cancelled
和 interrupted turn 保留审计记录，但不会作为成功上下文重放。新 session 会清除当前
transcript；transcript 不可用时才回退到有界的 ADS history projection。

`ephemeral` session 是全新且不持久化的 session。独立 Actions Reviewer session 使用此
lifecycle，并在 verdict 产生后释放。它们不写入 durable thread state 或 Native
transcript state，之后也不能恢复。

Native provider request 只能作为一个 logical turn 重试，而且只能发生在可观察副作用
之前。取消信号会传递到 provider I/O 和正在执行的 tool。可重试 attempt 保持 checkpoint
打开；终态失败会关闭 checkpoint，且不会创建第二个 logical turn。tool call、command、
file change 和 final response 继续遵守共享 `AgentEvent` 契约。

### Persistence and context projection

durable Native transcript 是恢复事实来源。每次 provider request 前，ADS 都在不修改
transcript 的前提下派生 token-budgeted context projection。user turn 及其 assistant/tool
chain 保持原子性；过大的 tool output 只在 projection 中截断，并写入诊断 marker。如果
无法容纳一个非 tool turn，请求以结构化 `NATIVE_CONTEXT_LIMIT` error 失败。compaction
诊断是 `context` event，不是 transcript state，也不是 Codex thread compaction。

### Capability contract

Provider capability 使用 `supported`、`unsupported`、`unknown` 三态。Native adapter 默认
支持 streaming、non-streaming、tool call、parallel tool call、usage 和 context metadata；
不支持 image input。除非 model/provider 配置明确声明支持，否则 structured output、
reasoning effort 和 provider-specific options 都是 unknown。请求 unknown 或 unsupported
能力时，在 provider request 前以 `NATIVE_CAPABILITY_UNSUPPORTED` 失败；ADS 不做静默降级。

共享 `AgentAdapter` 接口不代表 security policy 相同。Codex app-server 使用其配置的
sandbox policy；Native 则在宿主机直接执行 command，同时保留现有 command safety、
allowlist、timeout、output 和 cancellation 检查。Native 继承宿主 environment 和 `$HOME`；
运维必须把 `ADS_AGENT_RUNTIME=native` 视为 `danger-full-access` 执行选择，而不是 Codex
sandbox 的等价模式。

## Consequences

- 运维无需混淆 logical agent、provider identity 和 transcript identity，即可识别当前
  backend 及其恢复语义。
- durable Native session 恢复 completed turn，ephemeral session 保持隔离且可丢弃。
- capability failure 显式且可操作，不会被静默忽略或伪装成成功执行。
- Native 直接宿主机执行仍是有明确风险的安全取舍，不应被描述为 Codex app-server
  sandbox 的等价物。
- 该契约由 runtime preflight 以及共享 backend 测试共同验证：
  `tests/actions/runtimePreflight.test.ts`、`tests/actions/runtimeBackendContract.test.ts`
  和 `tests/runtime/agentAdapterContract.test.ts`。

## Related work

本 ADR 汇总 [ADR 0021](0021-exclusive-runtime-backend-lifecycle.md)、
[ADR 0022](0022-persist-native-runtime-transcripts.md)、
[ADR 0023](0023-token-aware-native-context-projection.md)、
[ADR 0024](0024-native-provider-capability-contract.md) 和
[ADR 0025](0025-native-bounded-retry-and-recovery.md) 中的 lifecycle、persistence、
projection、capability 和 recovery 决策。它是 #361 Native Runtime parity 工作及其
实现切片 #369、#370、#371、#372、#373、#374 的文档边界。
