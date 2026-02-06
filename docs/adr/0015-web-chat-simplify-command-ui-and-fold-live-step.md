# ADR-0015: Web Chat - Simplify Command UI and Fold Live-Step Trace

- Status: Accepted
- Date: 2026-02-06
- Supersedes: ADR-0006, ADR-0009 (and partially ADR-0013)

## Context

Web Chat 里存在两类“高频但低价值”的 UI 噪音源：

1. **Command UI 的终态渲染过重**
   - Turn 进行中展示 per-command `execute` 预览是必要的（用于实时反馈）。
   - Turn 结束后再把命令汇总成 `command tree` 长期留在消息流中，会：
     - 放大历史对话体积与干扰阅读；
     - 与任务面板/日志（更适合承载审计信息）产生重复。

2. **Live-step trace 的滚动条交互干扰主对话**
   - 之前的做法是给 `live-step` 的 Markdown 区域设置 `max-height` + `overflow-y: auto`。
   - 实际体验上，滚动条会制造“第二个可滚动容器”，在移动端/触控板下尤其容易误滚；
   - 用户的核心诉求是“能看到最新 step 输出”和“必要时展开查看”，而不是在小窗口里精细滚动。

此外，在 Planner/Worker 双面板布局下，中间 Planner 列需要更轻的滚动条视觉权重，避免与主消息流抢注意力。

## Decision

1. **Command UI 只保留“运行时 execute 预览”，不在 turn 完成后留下终态 command tree**
   - `execute` 预览继续按 stack 逻辑展示（用于 turn 内实时反馈）。
   - Turn 完成后：
     - 移除 `execute` 预览块；
     - 不再插入 `kind="command"` 的总结/命令树消息到主消息流。

2. **Live-step trace 改为“固定 3 行折叠 + 可选展开/收起”，替代滚动条**
   - 默认仅显示 3 行高度（CSS clamp）。
   - 当内容超出时显示 `Expand` 按钮；展开后显示 `Collapse`。
   - Live-step 在折叠状态下保持“tail -f”式自动跟随最新输出；展开状态下停止自动滚动，避免打断用户阅读位置。

3. **Planner 面板使用更细的滚动条样式**
   - 仅对 Planner 容器生效（通过 `.chatHost--planner` hook），不改变 Worker 的主对话滚动体验。

## Consequences

- 正向：
  - 主消息流更干净，turn 完成后不会残留大段命令噪音。
  - Live-step 交互更接近“折叠摘要/展开详情”，减少嵌套滚动容器带来的误操作。
  - Planner 面板视觉更轻，符合其“随时可聊但不抢戏”的定位。

- 负向/风险：
  - 失去在主消息流中回看“完整命令列表”的能力；需要依赖任务系统、服务日志或 workspace patch artifacts 做审计/回溯。
  - Live-step 展开后不自动滚动，用户可能需要手动滚到最新位置（这是刻意选择，避免阅读时被抢走滚动位置）。

## Implementation Notes

- Suppress finalized command tree items:
  - `web/src/components/MainChat.vue`: `renderMessages` filters out `kind="command"`.
  - `web/src/app/chatExecute.ts`: `finalizeCommandBlock()` only removes `execute` items; it no longer injects a `command` item.
  - `web/src/app/projectsWs/wsMessage.ts`: history merge ignores command-kind entries (do not rehydrate into chat).

- Fold/expand live-step:
  - `web/src/components/MainChat.vue`: introduces `liveStepExpanded` / `liveStepHasOverflow` and a toggle button.
  - `web/src/components/MainChat.css`: clamps `.liveStepBody :deep(.md)` to `max-height: 3lh` with `overflow: hidden`.

- Planner scrollbar:
  - `web/src/App.vue`: adds `.chatHost--planner` class to the planner chat host.
  - `web/src/components/MainChat.css`: adds scrollbar styling under `.chatHost--planner .chat`.

- Regression tests:
  - `web/src/__tests__/command-ui-lifecycle.test.ts`
  - `web/src/__tests__/execute-stacking-and-command-collapse.test.ts`
  - `web/src/__tests__/live-step-scroll-style.test.ts`
  - `web/src/__tests__/live-step-scrollbar.test.ts`
  - `web/src/__tests__/planner-scrollbar.test.ts`

