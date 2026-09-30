# ADR 0036: Preserve Native Task Context Across Interrupted Turns

## Status

Accepted

## Context

Native runtime 原先只把 `completed` 轮次加入下一次请求。`cancelled`、`interrupted`、
`failed` 轮次虽然保存在 transcript 中，原始用户任务和已完成工具结果却被整体排除。
同实例继续和重建 session 都因此可能只把“继续”发送给模型。旧测试与 ADR 0022 将
“未成功完成”错误等同于“不应成为上下文”，Issue #491 修正这一边界。

## Decision

1. 执行状态与上下文可恢复性分离。保持原始 transcript、终态、工具结果及 writer
   fencing 不变；同实例终态处理和 durable restore 使用相同的 continuation projection。
2. 对未完成轮次保留原始 user message（包括图片引用）、完整确认的 assistant/tool
   exchange，并附加明确注明由 runtime 生成的未完成状态消息。这不是模型的成功答复，
   不写回原始 transcript，也不作为新的 UI 回复广播。未完成的上游流片段不冒充完整答复。
3. 尚无结果的 tool call 在请求投影中补上 `status: unknown` 的 tool result，明确说明
   可能未执行，也可能已经产生副作用，应先检查实际状态。补充项只用于协议配对；
   不声称工具成功或完全未执行，不自动重放工具。
4. 只有逻辑 turn 进入终态后才加入上下文。自动 retry 的各次 attempt 不重复加入；
   取消 retry backoff、超时、错误和进程重建均遵守相同规则。显式 reset 仍清空上下文，
   transcript、owner、project 和 lifecycle 的隔离不变。
5. 连续未完成轮次和下一条 user request 组成一个必须保留的 context group。预算不足时
   沿用 ADR 0023 的工具输出截断；无法容纳任务本身时明确失败，不静默删除原始任务。
   后续成功轮次结束这个必保留边界；本变更不实现无限上下文或语义摘要。
6. SessionManager 的只读可恢复性探测不再只检查 completed 轮次。原始 running
   checkpoint 的失效仍由新 writer claim 完成；探测本身不抢占或中断旧 writer。

## Consequences

- 中断后继续可以看到原始任务、已确认结果和不确定结果，而不是被要求猜测任务。
- 原始审计记录与发给 provider 的派生上下文保持分离，无数据库 schema 迁移。
- 未完成任务会占用后续上下文预算，超限时宁可明确报错，也不隐式丢失任务。
- 更新 ADR 0022、0023 和 0026 的恢复契约；ADR 0025 的取消与副作用重试边界不变。
- 回归覆盖请求体、同实例/重建恢复、工具执行中断、批量工具部分完成、retry 取消、
  图片引用、显式 reset、writer fencing、session 隔离及 token 压力。
