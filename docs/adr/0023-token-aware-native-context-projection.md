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
6. [ADR 0036](0036-preserve-native-interrupted-context.md) 定义的连续未完成轮次与下一条
   user request 作为必保留组一起预算。组内工具结果可按上述规则截断；任务本身
   无法容纳时明确失败，不能只留下“继续”而丢掉其所指的原始任务。
7. 模型预算优先读取 `max_input_tokens` 和 `max_output_tokens`，其次兼容旧字段及
   环境变量。262144 上下文和 131072 输出预留仅作为 fallback，不能将前者当成硬下限。
   未配置输出且窗口较小时，预留最多为窗口一半；显式输出不受原有 25% 比例限制，
   但须至少留下 64 token 输入空间。上游 `max_tokens` 与 projection 使用同一个有效预留。
8. 同一工具循环内，使用最近一次有效 provider 输入 usage 与对应**实际发送投影**的
   原始字符估算值计算比例，至少为 1，再统一校准消息、工具定义与截断预算。分母不能
   使用已经校准过的 diagnostic，也不能使用压缩前的完整历史，避免比例复合或低估。
   缺失 usage 时沿用该循环最近的有效比例；新 turn、重试及重新解析模型时清空。
   累计 billing usage 保持现有语义，不能作为当前上下文占用量。

## Consequences

- Native provider 请求不会因为历史消息数量固定而失控，也不会生成孤立的 tool
  result；长对话和 tool-heavy turn 可以在固定预算内继续运行。
- 字符/token estimator 加上实际输入 usage 校准仍是 provider 无关的近似，不能保证
  内容分布变化时与真实 tokenizer 一致；输出或 reasoning usage 不作为下一请求的输入
  token 总量使用。后续可在不改变 projection 契约的前提下替换为 provider-specific estimator。
- 超大 tool output 的持久化内容仍完整保留，只有发送给 provider 的派生副本会被
  截断，因此诊断和恢复不会丢失原始执行结果。
