# ADR 0008: Keep WebSocket Transport Alive Across Lane Resets

## Status

Accepted

## Context

当前 WebSocket 连接同时承担传输和逻辑会话生命周期。Planner 的“新建会话”会复用 `clear_history`，服务端递增 lane generation 后通过 1012 关闭所有相关连接，再依赖客户端重连建立新的 generation。

这种实现可以阻断旧 generation 的消息，但会带来不必要的 TLS/WebSocket 重连、连接状态闪烁和输入延迟。Worker 已经通过 `switch_chat_session` 证明，逻辑会话可以在同一条 WebSocket 上完成切换。

## Decision

会话重置采用带内协议完成，物理 WebSocket 的生命周期与逻辑 lane/session 生命周期解耦。

服务端在 reset 时必须按原子顺序完成以下工作：

1. 建立 reset barrier，阻止新消息写入或执行旧 generation。
2. 终止旧 generation 的运行、清理历史和同步事件，并递增 lane generation。
3. 将所有受影响的活动连接重新绑定到新的 history key、user id、SessionManager、orchestrator 和 sync lane。
4. 广播 `session_reset`，随后向每个活动连接发送新的 generation-aware bootstrap/welcome。
5. 释放 barrier，允许新消息在新 generation 上执行。

Planner 始终保持 `chatSessionId = "planner"`，Planner 新会话不得通过随机 chat session id 伪装成 Worker lane。Worker 继续使用已有的 `switch_chat_session` 带内切换。

## Consequences

正面影响：

- 新建会话和清空历史不再触发物理连接重连。
- generation fence 仍然阻止旧历史、旧命令和旧 prompt 污染新会话。
- 多个同 lane 连接可以获得一致的 reset/bootstrap 状态。
- 客户端可以在已有连接上完成 outbox、sync cursor 和可见会话状态清理。

代价与约束：

- 服务端必须维护连接级 lane rebind，而不能只递增全局 generation。
- reset 期间的消息必须等待 barrier 或被明确拒绝，不能静默写入旧 history key。
- `session_reset` 与新的 welcome/bootstrap 必须保持确定顺序；相关协议行为需要 WebSocket 集成测试覆盖。
