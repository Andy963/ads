# WebSocket 合同状态

Rust 已实现 `/ws` 握手、鉴权/Origin、bootstrap、history、同 generation
durable replay、lane/shared reset、会话切换、`prompt_queue_snapshot`、prompt
入队 ACK、`cancel_prompt`、`prompt_reconcile` 与 `prompt_queue` durable event
切片。本目录的 `frames.json` 仍是静态字面量清单，不是完整协议 schema。

握手路径为 `/ws`，子协议包括：

- `ads-v1`
- `ads-session.<session-id>`
- `ads-chat.<chat-session-id>`

重连 query 支持 `afterSeq` / `laneGeneration`，以及客户端实际使用的
`afterSeq.<chat-session-id>` / `laneGeneration.<chat-session-id>`。Envelope 允许扩展：

```json
{
  "type": "string",
  "payload": "unknown (optional)",
  "client_message_id": "string (optional)",
  "chat_session_id": "string (optional)"
}
```

`frames.json` 是静态字面量清单，不是完整协议 schema。当前行为测试已覆盖
bootstrap/history 顺序、同 generation 重放、lane/shared reset、会话切换和
prompt queue 入队/差异化 ACK；command 接入后的完整 reset barrier 仍需补充
行为测试。

已对齐的行为：

- 初始帧顺序 `welcome -> replay -> agents -> prompt_queue_snapshot`；
  snapshot 读取真实 `prompt_queue` 行并过滤 completed。
- 未鉴权 `4401`、Origin 拒绝 `4403`、超过最大连接数 `4409`、
  bootstrap 失败 `1011`。
- `ads-session.default` 映射到 workspace project session；
  `advisor` / `planner` 归一化为 `acopilot`。
- 同 generation durable replay、command 帧投影、JSON ping/pong、
  非法 JSON/payload 与 `session_changed`。
- `history` bootstrap、`clear_history` 的 generation fence/DB 清理/
  `session_reset` 广播，以及 source 与兄弟连接的原地 rebind。
- `switch_chat_session` 的项目选择持久化与同项目连接 rebind。
- prompt 入队 ACK、`prompt_queue` coalesced durable event/replay、
  `cancel_prompt` 与 `prompt_reconcile`。

`session_reset` 是控制帧，不写入 `sync_events`；reset 后的新 generation
不会从旧 replay log 恢复。

尚未实现 command 入站分发、完整 reset barrier、inFlight/status/runtime snapshot
bootstrap、多 lane 复用，以及 Native Runtime 实际执行与流式输出。当前 prompt
runner 会显式失败，避免迁移期间伪造 completed 状态。
