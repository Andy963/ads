# Web WS queued message persistence

> 日期：2026-02-12  
> 状态：Draft

## 背景

当前 Web UI 通过 WebSocket 发送 `prompt`/`command` 到后端。后端为了保证同一连接上的消息按顺序执行，会把消息串行化处理（per-connection chain）。

问题：当上一条消息执行时间较长时，后续用户输入可能会在“进入执行链之前”就因为刷新/断线而丢失，导致：

- 数据库（`state.db`）里没有对应的对话记录；
- 刷新后 UI 无法从后端 `history` 恢复这条用户输入；
- 用户感知为“消息没发出去/被吞了”。

## 目标

1. **可靠记录**：对 WebSocket 收到的用户 `prompt`/`command`，在进入串行执行链之前，尽可能早地将用户输入持久化到 `state.db` 的 `history_entries`（通过 `HistoryStore`）。
2. **去重**：如果客户端因为刷新/重连导致重复发送同一条消息（同一个 `client_message_id`），后端应能识别并避免重复执行。
3. **不污染上下文**：在需要做 history injection（恢复上下文）时，不应把“未来排队但尚未执行”的消息注入到当前 prompt 的上下文里，避免串台。

## 非目标

- 不保证断线后仍“自动继续执行”未开始执行的队列消息（不引入服务端 inbox 状态机/重放机制）。
- 不改变现有 task queue / planner 流程语义。

## 约束

- 不删除或覆盖任何数据库文件。
- Web UI 兼容现有协议（`WsMessage` 结构不破坏）。

## 验收标准

- 当第一条 `command` 阻塞执行时，第二条携带 `client_message_id` 的 `command` 即使在刷新/断线后也能在 `history_entries` 中看到。
- 重复发送同一 `client_message_id` 的 `prompt`/`command` 不会导致重复执行。
- history injection 不包含 `ts` 大于当前消息接收时间的排队消息。

