# ADR-0005: Chat Message Timestamps and Mobile Login Keyboard Handling

- Status: Accepted
- Date: 2026-01-30

## Context

Web UI 的聊天区在调试与协作场景下，经常需要快速判断每条消息发生的时间。此前每条消息下方只有“复制”按钮，缺少时间信息，导致：

- 追踪断线重连后的消息合并是否正确较困难；
- 任务/对话跨项目切换后，对齐时间线不直观。

同时，移动端登录页使用固定居中布局（`place-items: center`），当弹出软键盘时可视区域高度缩小，输入框可能被遮挡，用户无法完成登录。

## Decision

1. 为 chat 消息增加可选的时间戳字段 `ts`，并在 UI 中展示：
   - 在每条消息的“复制”按钮右侧显示时间（当日显示 `HH:mm`，跨日显示 `YYYY-MM-DD HH:mm`）。
   - 历史同步时从后端 `history.items[].ts` 透传；本地新增消息缺省使用 `Date.now()`。
   - 对 streaming 的 live message（step/activity）保持稳定时间戳，避免每次 delta 更新都刷新时间。
2. 登录页容器改为可滚动的自适应布局，以适配移动端软键盘：
   - 使用 `min-height: 100dvh`，并启用 `overflow-y: auto`；
   - 小屏时顶部对齐（`align-items: flex-start`），确保键盘弹出后仍能滚动到输入框与按钮。

## Consequences

- 正向：
  - 用户可快速定位消息时间点，便于排查重连/合并与任务执行节奏；
  - 移动端键盘弹出后登录表单可滚动可达，减少“看不到输入框”的阻塞。

- 负向/风险：
  - `ts` 是 UI 侧的弱一致性字段：当后端未提供 `ts` 时，使用本地时间可能与真实发生时间存在偏差。

## Implementation Notes

- `ts` 透传与缺省写入：`web/src/App.vue`
- 消息时间渲染：`web/src/components/MainChat.vue`, `web/src/components/TaskDetail.vue`
- 登录页布局：`web/src/components/LoginGate.vue`

