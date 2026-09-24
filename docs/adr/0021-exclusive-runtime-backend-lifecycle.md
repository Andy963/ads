# ADR 0021: Enforce Exclusive Runtime Backend and Session Lifecycle

## Status

Accepted

## Context

ADS 对外暴露 `codex` 作为逻辑 agent 标识，同时在 Codex app-server adapter 和
进程内 Native Runtime adapter 之间选择实际执行 backend。旧状态格式没有记录
这一选择，重连时可能把 Native execution id 误认为 Codex provider thread。
逻辑 agent id 属于 Web、Actions 和 Telegram 的公共契约，必须保持稳定；实际
执行 backend 则是独立的进程级概念。

## Decision

1. 一个进程为所有 session 选择唯一的 runtime backend。持久化 session state
   明确记录 backend 和 lifecycle，用于诊断和安全恢复判断。
2. 一个 session 生命周期内只能绑定一个 backend。持久化 backend 与当前进程
   backend 不一致时直接抛出明确错误；ADS 不在 runtime 之间迁移或注入历史。
3. 逻辑 agent id 保持为 `codex`。Native execution id 只存在于进程内，不能写入
   durable thread storage 或 history session link，也不能传给 app-server
   adapter；Native adapter 会拒绝 provider thread resume id。
4. session 使用明确的 `durable` 或 `ephemeral` lifecycle。durable session 可以
   保存 Codex provider thread 状态；ephemeral session（包括 detached Actions
   Reviewer）不写入 session state，并在使用后释放。
5. 没有 runtime metadata 的旧记录视为身份不确定，只使用 history injection，不
   尝试 provider-thread resume，避免把旧 Native execution id 当成 Codex thread。
6. capability matrix 由 `RUNTIME_CAPABILITY_MATRIX` 表示，区分 supported、
   unsupported 和 intentionally different 行为。本 ADR 不实现 provider 请求、
   transcript persistence、compaction 或跨 runtime migration。

## Consequences

- 重连和诊断时 backend 选择明确，不安全的跨 runtime 复用会尽早失败。
- 在未来明确设计 Native transcript persistence 之前，Native session 不具备
  durable provider-thread resume 能力。
- 旧 session 可能需要一次 history injection，但不会静默获得错误的 provider
  context。
- capability matrix 和 lifecycle metadata 成为 session state 契约的一部分，
  后续存储变更必须保留它们。
