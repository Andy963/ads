# Design

## 核心思路

“是否显示展开按钮”不应该仅由 DOM 测得的 overflow 决定，因为 heading 的 margin、固定 clamp 高度、以及 streaming 下的布局抖动都会导致误判。

改为基于 Markdown 结构判定“展开是否有信息增量”：

- 若 content 中存在“有意义正文”（非标题、非仅加粗标题段落），则展开能提供增量信息，应展示 `Expand`。
- 若存在被折叠隐藏的 outline 标题（如超过折叠展示上限），展开能展示更多标题，也应展示 `Expand`。
- 若 content 只有单个标题且无有意义正文，则展开没有信息增量，隐藏 `Expand`。

## Markdown 结构分析

在 `web/src/lib/markdown.ts` 增加 `analyzeMarkdownOutline(markdown)`：

- 输出：
  - `titles`: 与现有 outline 抽取逻辑一致（heading + strong-only paragraph）。
  - `hasMeaningfulBody`: 是否存在除标题之外的可见内容（例如普通段落、列表、代码块、引用等）。

该函数与 UI 渲染解耦，便于复用与单元测试。

## UI 逻辑

在 `MainChat.vue` 中新增：

- `liveStepCollapsedTrivialOutline`：
  - `outlineTitles.length === 1`
  - `hasMeaningfulBody === false`
  - `outlineHiddenCount === 0`
  - 且处于折叠态
- `liveStepCanToggleExpanded`：
  - 展开态始终可 `Collapse`
  - 折叠态仅在“展开有增量”时显示 `Expand`

并将 live-step 的 clamp 渐变遮罩仅在可展开时启用，避免 trivial case 下出现无意义的遮罩。

## 样式调整

为 trivial outline case 增加 `data-trivial-outline="true"`：

- 放松 `min-height: 3lh` 约束，使仅单标题的折叠态更紧凑，减少留白。

