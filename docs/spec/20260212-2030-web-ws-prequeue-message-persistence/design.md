# Design: Web WS pre-queue persistence

> 日期：2026-02-12  
> 状态：Draft

## Overview

核心思路：把“落库 + ack + 去重”从 per-connection 串行执行链中拆出来，放到 `ws.on("message")` 的同步入口处完成。

### Why

- 现状：只有当消息进入 `handleOneMessage()` 之后才会调用 `historyStore.add()`，而 `handleOneMessage()` 被 `messageChain` 串行化。队列中的消息不会立刻落库。
- 刷新/断线：连接中断后，队列里尚未进入 `handleOneMessage()` 的消息可能永远不会被处理。

## Data model

仍然使用现有 `HistoryStore`：

- DB: `state.db`
- Table: `history_entries(namespace, session_id, role, text, ts, kind)`
- Dedup key: `kind = 'client_message_id:<id>'`（利用现有唯一索引）

不引入新的 inbox 表。

## Message flow

1. `ws.on("message")` 收到 raw data：
   - JSON parse + schema validate（复用现有 zod schema）
   - 若 `type in {"prompt","command"}` 且存在 `client_message_id`：
     - 提取可持久化的 user text（尽量与 UI 显示一致）
     - `historyStore.add(historyKey, { role: "user", text, ts: receivedAt, kind: "client_message_id:<id>" })`
     - 立即向客户端发送 `{ type: "ack", client_message_id, duplicate }`
     - 若 `duplicate=true`，不进入执行链（避免重复执行）
2. 非 duplicate 的消息进入 `messageChain`，按顺序执行原有 `handle*Message()`。

## History injection cutoff

当 `SessionManager.needsHistoryInjection(userId)` 为 true 时，构造 injection context 时只读取：

- `history_entries.ts <= receivedAt`

从而避免把“未来排队消息”注入到当前 prompt 的上下文里。

## Risks

- ack 提前发送：ack 表示“已接收并持久化”，不等价于“已执行成功”。需要保持 UI 行为一致（现有 UI 仅用 ack 清理本地 pending prompt）。
- prompt payload 含图片：预持久化不落盘图片文件，只记录文本 + `[图片 xN]` 的占位信息。

