# ADR-0012: Stabilize TaskCreateForm Voice Icon Position

- Status: Accepted
- Date: 2026-02-03

## Context

“新建任务”表单的任务描述输入框支持语音输入（mic icon）。

此前 UI 会在 `prompt` 为空时将 mic icon 放在输入框底部居中；一旦用户开始输入文字，mic icon 又会移动到输入框右下角。这种“位置跳变”会带来两个问题：

- 用户输入后容易误以为 mic icon “消失了”（实际只是移动到了右下角），降低可发现性。
- 布局在输入过程产生不必要的视觉抖动，分散注意力。

目标是：保持语音入口的位置稳定，减少误解与视觉跳变。

## Decision

1. 移除 `voiceBottomCentered` 的动态行为。
2. mic icon 始终固定在输入框的右下角（定位仍然相对于输入框容器，而非屏幕/viewport）。

## Consequences

- 正向：
  - 语音入口位置稳定，用户不会因为输入文字而产生“按钮消失”的误解。
  - UI 行为更一致，减少布局跳动。

- 负向/取舍：
  - 空输入状态下不再有“底部居中”的强提示；语音入口不再被刻意强调。

## Implementation Notes

- Remove `voiceBottomCentered` class toggle: `web/src/components/TaskCreateForm.vue`
- Remove related CSS overrides: `web/src/components/TaskCreateForm.css`

