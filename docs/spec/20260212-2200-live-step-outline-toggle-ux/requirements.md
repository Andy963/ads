# Requirements

## 背景

Web 聊天的 live-step（思维链/步骤流）在折叠态会优先展示 outline（小标题列表），并在内容溢出时显示 `Expand` / `Collapse`。

当 live-step 只包含单个标题且没有任何可展开的正文时，UI 仍可能出现 `Expand` 按钮（通常由高度/溢出判定或 heading margin 触发），导致交互误导与观感怪异。

## 目标

1. 当 live-step 仅有一个标题且无“有意义正文”时，折叠态不显示 `Expand` 按钮。
2. 保持折叠态优先展示 outline（多条小标题）的现有体验；展开态展示完整 Markdown 内容。
3. 不引入后端协议变更，不修改消息结构，仅做前端渲染与样式调整。

## 非目标

- 不做整体国际化/文案统一（例如把 `Expand` 改为中文）。
- 不改变 live-step 的数据来源与 streaming 行为。

## 验收标准

- 当 live-step content 为 `**Title**` 或 `# Title` 等“仅标题”形式时：
  - 折叠态显示 outline（单条标题）；
  - 不显示 `Expand` 按钮；
  - 不出现 clamp 渐变遮罩造成的视觉噪音。
- 当 live-step content 包含标题 + 正文，且正文即使不溢出也应可展开查看时：
  - 折叠态显示 outline；
  - 显示 `Expand` 按钮；
  - 点击 `Expand` 后显示正文，且 `Collapse` 可恢复折叠态。

## 验证

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npx vitest run --config web/vitest.config.ts`
- `npm run build`

