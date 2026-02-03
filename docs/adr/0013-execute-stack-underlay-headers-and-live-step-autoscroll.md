# ADR-0013: Execute Stack Underlay Headers and Live-Step Auto-Scroll Robustness

- Status: Accepted
- Date: 2026-02-03

## Context

Web 对话区在高频命令执行与长时间推理输出时，存在两个可用性问题：

1. **Execute 预览堆叠可读性不足**
   - Execute stack 的 underlay 仅展示卡片轮廓，无法快速识别每一层对应的命令；
   - 当连续执行命令较多时，用户通常只关心“最新几条命令”，但旧逻辑对 underlay 的选择与展示不够直观。

2. **Live-step 推理输出在被裁剪后可能停止自动滚动**
   - Live-step 输出在达到长度/行数上限后会被裁剪；
   - 如果仅监听 `content.length`，裁剪后长度可能保持不变，即使内容持续更新也不会触发自动滚动，导致用户看不到最新内容。

## Decision

1. Execute stack underlay 增加最小 header 信息：
   - Underlay 显示 `EXECUTE` 标签与对应的命令（单行省略）。
   - 保持视觉堆叠仍然是“peek”效果，不展开旧输出正文。

2. Execute stack 的可视堆叠始终取“最新 N 条”（N=3）：
   - 仍保留 `stackCount` 表示真实连续 execute 数量；
   - 但 UI 只渲染最新 3 条对应的顶层卡片与 underlays，避免旧命令挤占有限视觉空间。

3. Live-step 自动滚动的触发条件改为监听完整内容：
   - Watch `content` 字符串而不是 `content.length`，确保“长度不变但内容变化”的场景仍能触发自动滚动逻辑。

## Consequences

- 正向：
  - Execute underlay 可快速识别对应命令，提高可读性；
  - 堆叠展示更贴合用户关注点（最新几条），同时仍保留总数信息；
  - Live-step 在裁剪场景下持续跟随最新输出，减少“看不到更新”的困扰。

- 负向/限制：
  - Underlay 的 header 会占用更多 peek 空间，需要增大 `--execute-stack-peek` 以避免布局拥挤；
  - 仍不提供“展开查看旧 execute 正文”的交互（设计保持不变）。

## Implementation Notes

- Execute stack 渲染与 underlay 内容：`web/src/components/MainChat.vue`
- Stack peek 与 underlay header 样式：`web/src/components/MainChat.css`
- Live-step auto-scroll watch：`web/src/components/MainChat.vue`
- 回归测试：`web/src/__tests__/execute-stacking-and-command-collapse.test.ts`, `web/src/__tests__/execute-preview-queue-order.test.ts`, `web/src/__tests__/live-step-scroll-style.test.ts`

