# Implementation

## 变更点

1. `web/src/lib/markdown.ts`
   - 新增 `analyzeMarkdownOutline()`，在解析 tokens 的同时抽取 outline titles 并判定 `hasMeaningfulBody`。

2. `web/src/components/MainChat.vue`
   - 使用 `analyzeMarkdownOutline()` 替代仅标题抽取。
   - 引入 `liveStepCollapsedTrivialOutline` 与 `liveStepCanToggleExpanded`：
     - trivial case 下隐藏 `Expand`。
     - 仅在可展开时启用 clamp 渐变遮罩。
   - 增加 `data-trivial-outline` 供 CSS 使用。

3. `web/src/components/MainChat.css`
   - 针对 `data-trivial-outline="true"` 放宽 `.md` 的 `min-height/max-height`，让单标题折叠态更紧凑。

4. `web/src/__tests__/live-step-outline-preview.test.ts`
   - 新增用例：当只有一个标题且无正文时，即便 overflow 被模拟为 true，也不显示 `Expand`。

## 回归关注点

- 多标题 outline（<=3）且无正文：不应显示 `Expand`（信息增量为 0）。
- 多标题 outline（>3）：应显示 `Expand`（可查看更多标题）。
- 标题 + 正文（正文短/不溢出）：仍应显示 `Expand`（否则正文不可达）。
- Streaming 更新时的 auto-scroll 与 pinned-to-bottom 行为不应受影响。

