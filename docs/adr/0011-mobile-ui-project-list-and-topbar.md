# ADR-0011: Mobile UI Project List + Topbar Layout Tweaks

- Status: Accepted
- Date: 2026-02-03

## Context

移动端屏幕宽度有限，但当前 Web UI 存在几处“为省空间而牺牲可用性”的布局：

- **项目列表**：将项目名与 git 分支信息压在同一行，导致点击区域过窄、误触率高，也不利于在小屏上快速识别与切换。
- **顶部导航栏**：已经有“项目 / 对话”切换 tabs，但仍重复展示当前项目路径，进一步挤占有限的顶部空间。
- **对话区容器**：存在多余的空白 header（PC 端已移除），在移动端造成不必要的垂直浪费。

目标是：在不增加交互复杂度的前提下，优先恢复移动端的可操作性与信息可读性，并与 PC 端保持一致的视觉结构。

## Decision

1. **项目列表行统一为两行信息结构**
   - 第一行显示项目名（或路径/名称）。
   - 第二行显示 git 分支，使用更小字号显示。
   - 移除移动端将其强制合并为单行的 CSS 覆盖，使 PC/移动端结构一致。

2. **移动端顶部导航栏不再重复展示项目路径**
   - 保留“项目 / 对话”tabs 作为主要导航。
   - 隐藏冗余的 `activeProjectDisplay` 文案，释放顶部空间。

3. **对话容器移除空白 header，并仅在“活跃对话”时显示顶部绿色指示线**
   - 绿色指示线仅在 `busy` 或存在历史消息时显示，避免空闲状态的视觉噪音。

## Consequences

- 正向：
  - 小屏可点击区域更友好，降低误触，切换项目更顺畅。
  - 顶部空间更充裕，tabs 与状态指示更清晰。
  - 移动端与 PC 端结构一致，减少“同一功能不同端行为不一致”的认知成本。

- 负向/取舍：
  - 移动端顶部不再常驻显示项目路径；需要通过项目列表/tooltip 等位置获取完整路径信息。

## Implementation Notes

- 项目列表分支布局：`web/src/App.css`
- 顶部导航栏移除项目路径：`web/src/App.vue`, `web/src/App.css`
- 对话容器（绿线与 header）：`web/src/components/MainChat.vue`, `web/src/components/MainChat.css`
- 回归测试：`web/src/__tests__/project-row-mobile-layout.test.ts`, `web/src/__tests__/mobile-pane-tabs.test.ts`, `web/src/__tests__/mainchat-header-ui.test.ts`

