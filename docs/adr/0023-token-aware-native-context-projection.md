# ADR 0023: 为 Native Runtime 引入 Token-aware Context Projection

## Status

Accepted

## Context

Native Runtime 原先按消息数组截断历史。该策略既没有使用模型 context window，
也可能把 assistant tool call 与对应 tool result 分到不同的 provider 请求中，导致
无效的 Chat Completions 消息序列。随着 durable transcript 恢复机制落地，原始
transcript 已经可以长期保存，但发送给 provider 的派生上下文仍需要有独立的、
可测试的预算策略。

## Decision

1. 每次 provider 请求都从完整 Native transcript 派生 context projection，不修改或
   覆盖 durable transcript。
2. projection 以 user message 为 turn 边界；一个 turn 内的 assistant tool call 与
   tool result 保持原子关系，检测到孤立或不完整的 tool chain 时拒绝请求。
3. 使用保守的字符/token estimator，并优先读取模型配置中的 context window；没有
   provider metadata 时使用可配置的保守 fallback。输入预算为 context window 减去
   completion reserve，且每次请求附带的 tool definitions 也计入该预算。
4. 从最新 turn 向后选择完整 turn。旧 turn 超出预算时直接丢弃；最新 turn 的
   超大 tool output 仅在派生 projection 中截断，并写入明确 marker。无法容纳的
   非 tool turn 返回带 `NATIVE_CONTEXT_LIMIT` code 的 context-limit error。
5. 每次发生 compaction 时发出结构化 `context` item，包含预算、丢弃消息数和截断
   tool output 数等诊断信息。该事件不等同于 transcript 状态，也不触发 Codex
   thread compaction。

## Consequences

- Native provider 请求不会因为历史消息数量固定而失控，也不会生成孤立的 tool
  result；长对话和 tool-heavy turn 可以在固定预算内继续运行。
- 字符/token estimator 是 provider 无关的保守近似，不能保证所有模型的真实
  tokenizer 计数完全一致；后续可以在不改变 projection 契约的前提下替换为
  provider-specific estimator。
- 超大 tool output 的持久化内容仍完整保留，只有发送给 provider 的派生副本会被
  截断，因此诊断和恢复不会丢失原始执行结果。
