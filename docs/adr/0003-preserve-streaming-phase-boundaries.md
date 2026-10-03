# ADR 0003: Preserve Streaming Phase Boundaries Across Reconnects

## Status
Accepted

## Context

The Web Console receives assistant text as cumulative streaming updates while the
Codex app-server interleaves agent messages, tool work, and multiple turns. The
previous protocol had no durable boundary for a completed assistant item and used
one coalesced snapshot per lane. A reconnect could therefore restore unrelated
assistant phases as one message, overwrite earlier snapshots from a later turn, or
render assistant results without the user prompts that caused them.

## Decision

1. The worker WebSocket adapter emits `phase_complete` when an assistant
   `agent_message` item completes or a distinct assistant item begins. The client
   seals the active assistant card at this boundary, and the next phase starts a
   new card even when no command card is present.
2. The sync log stores each active assistant phase as a separately coalesced
   `delta_snapshot`. Snapshot event IDs include an instance-unique stream ID and
   phase index. Terminal events retire only the active unsealed snapshot; sealed
   intermediate phases remain available for replay.
3. Prompt preflight records a durable `user` sync event after history persistence.
   If that event cannot be recorded, only the newly inserted prompt entry is
   rolled back so the client can retry without creating a history duplicate.
4. History reconciliation uses bidirectional LCS alignment to backfill missing
   server entries while preserving persisted timestamps and execution metadata.

### 终态结果对齐（Issue #512）

- 服务端只要收集到非空助手条目，就在 `result.assistantItems` 中保留其
  provider item ID 和命令位置锚点；工具、ADR 或调度后处理改变输出，不得丢弃身份信息。
- 客户端以 `clientMessageId` 确定所属轮次，以 item ID 对齐条目，继续拒绝重复
  item ID。文本相等仅用于选择展示形式，不能用于识别消息或跨轮去重。
- 先按身份恢复条目和命令位置；若条目拼接文本与最终 `output` 在去除首尾空白后一致，
  保留独立助手条目及其与命令交错的顺序，包括文本相同但 ID 不同的条目。
- 若两者不一致，或该轮已从历史恢复为聚合消息，则将该轮助手文本合并为一个
  `assistantAggregate`，放在首个助手条目的位置，以最终 `output` 为权威内容。
  命令块之间的相对顺序与其他轮次保持不变；聚合内容与持久化历史一致。
- 重放终态结果必须幂等。聚合完成后，迟到的 provider 条目或增量不能覆盖或重新
  插入原始文本，即使最终输出为空也一样。未携带有效身份的旧协议仍使用既有回退路径。
- 本次不改变工具结果行的组成或持久化方式，不涉及发布、部署或生产数据变更。

## Consequences

### Positive

- Reconnect replay preserves the visible conversation topology and phase order.
- Multiple turns cannot overwrite each other's in-flight snapshots.
- User prompts and assistant results remain aligned in incremental sync.
- Replaying a snapshot is idempotent because it replaces the active text.

### Trade-offs

- The sync log retains sealed intermediate snapshots until normal lane retention
  removes them, increasing durable event volume during long-running turns.
- Legacy producers that omit item IDs receive conservative boundary behavior and
  cannot provide perfect phase attribution.
