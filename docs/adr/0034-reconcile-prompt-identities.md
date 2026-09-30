# ADR 0034: Reconcile Prompt Identities Against Durable Server State

## Status
Accepted

## Context
The browser outbox can survive longer than a WebSocket connection and may be restored by another tab or device. A client that missed the original running or completion event cannot infer that an old prompt was consumed from the active queue snapshot, because completed rows are not advertised there. Local dismissal and consumption caches also cannot serve as the cross-device authority.

Offline cancellation has the inverse race: a client may still hold a prompt after requesting cancellation, and replaying that prompt before the server records the cancellation can make it eligible again. Queue execution and cancellation therefore need one durable, scoped identity decision that clients can reconcile before restoring or dispatching old outbox entries.

## Decision
On WebSocket connection, the client sends the prompt identities held in its outbox, plus outstanding cancellation intents. The server resolves them using the authenticated connection's owner, session, chat session, logical lane, and lane generation. It returns only identity dispositions, not prompt text:

- `pending`: the current-generation row has not been claimed and remains eligible.
- `consumed`: the row was claimed or reached a terminal execution state.
- `cancelled`: a durable cancellation tombstone exists.
- `obsolete`: the identity belongs to an older lane generation and cannot be replayed in this generation.
- `unknown`: the server has no record in this scope; the client may preserve it as genuinely unsent work.

The browser does not restore or dispatch held outbox entries until this response arrives. `pending` is not a terminal decision: its outbox record and prompt text remain available for recovery. When a consumed decision arrives before the matching history frame, the client keeps the locally recovered user message until history catches up. Consumed, cancelled, and obsolete decisions are monotonic across browser storage and tabs. Cancellation intents are reconciled before any old prompt identity can be replayed.

The durable queue row is the source of consumed identity history; completed payloads remain scrubbed. Cancellation tombstones are retained independently of queue rows. Queue claim and cancellation remain mutually exclusive: cancellation may retire unclaimed work, while a running/claimed prompt is consumed and cannot be stopped through the queue-delete action. `replay_incomplete: true` is the explicit user-initiated retry signal: it requeues a *failed* row under its original identity (resetting it to a fresh attempt) once the history gate confirms the turn's last terminal record is an error rather than assistant output. It never overrides a completed (consumed) or cancelled decision; a turn whose history ends in assistant output stays terminal and its replay is rejected with a reasoned duplicate ack.

Terminal identity history has no time- or count-based eviction. Any future compaction must preserve equivalent durable deduplication and cancellation guarantees before old rows or tombstones can be removed.

### Original-payload retry

失败消息的聊天气泡只是展示文本，可能包含附件 Markdown、图片占位符，或者缺少原请求
的模型参数，不能用于重建同一消息 ID 的执行 payload。客户端显式重试增加
`retry_original: true`，与 `replay_incomplete: true` 一起声明“重试服务端保存的原请求”。
后端先验证账户、用户、session、lane generation 和 workspace，再从 failed row 读取
原始文本、图片与模型参数；不采用客户端重建的替代内容，不更换身份，也不放宽普通
重复发送的 payload hash 检查。queued/running/completed 保持幂等，cancelled、跨作用域
和缺失原记录明确失败；completed payload 仍保持清空。

客户端在首次交给 WebSocket 前固定完整发送内容，连接失败后沿用相同文本、图片和
模型设置，不重新上传图片或读取变更后的模型控件。离线重试沿用现有 outbox 文本与
执行元数据，仅增加原请求重试标记，不把图片 Base64 复制到浏览器 outbox；图片由
已有服务端请求恢复。

## Consequences
Reconnects take one server round trip before old outbox cards become visible or eligible for dispatch. Truly unsent work remains recoverable, while consumed and cancelled work cannot be resurrected by stale tabs, snapshots, or ACKs. Scope checks prevent one authenticated user or lane from learning another lane's identity disposition.

Durable terminal records grow over time. Completed prompt payloads are already scrubbed, and cancellation tombstones contain identity and scope metadata only; storage reduction requires a separately designed compact terminal ledger rather than a retention cutoff.
