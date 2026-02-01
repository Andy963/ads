# ADR-0009: Constrain Live Step Trace Output

- Status: Accepted
- Date: 2026-02-01

## Context

在 Web 对话界面中，assistant 在 turn 进行时会输出一段持续增长的“步骤/思维链 trace”（当前以 `id=live-step` 的消息呈现）。

这段内容有两个典型问题：

- 如果不做限制，会不断把对话区向下撑长，导致用户阅读其它消息被干扰。
- 即使限制了最大高度并开启内部滚动，默认也不会自动滚动到最新内容，用户需要反复手动滚动才能看到最新输出。

同时，用户在查看历史内容时不希望被强制“拉回到底部”。

## Decision

1. **限制 `live-step` 消息的可见高度**
   - 对 `live-step` 的 Markdown 渲染区域设置 `max-height`，并在超出时启用 `overflow-y: auto`，让内容在块内滚动而不是撑高整体布局。

2. **在块内滚动容器上实现“贴底跟随”的自动滚动**
   - 在 `live-step` streaming 期间，默认自动滚动到最新内容（类似 `tail -f`）。
   - 当用户在该滚动容器内向上滚动、离开底部一定阈值后，暂停自动滚动，避免打断阅读。
   - 当用户再次滚回底部，或新的 streaming session 开始时，恢复自动滚动。

## Implementation Notes

- 通过给消息根节点添加稳定的 `data-id` hook，定位 `live-step` 对应的滚动元素。
- 通过滚动事件维护一个“是否贴底”的状态（使用固定像素阈值判定）。
- 在内容更新后通过 `requestAnimationFrame` 合并滚动操作，减少频繁 layout 带来的抖动。

## Consequences

- 正向：
  - `live-step` 不再占据不可控的垂直空间；用户可以在不影响主对话流的情况下查看 trace。
  - 默认体验可持续看到最新内容；用户需要查看历史时也不会被强制拉回底部。
- 负向/限制：
  - 引入嵌套滚动容器（对少部分用户可能不如单一页面滚动直观）。
  - “贴底阈值”是启发式参数，极端布局/字体情况下可能需要调整。

