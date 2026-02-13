# Requirements

## 背景

Web UI 在单任务运行（single task run）请求返回后，会通过 toast notice 提示用户 `Task <id> queued/scheduled`。

当前提示只展示任务 id（截断到 8 位），在用户侧难以关联到具体任务内容，且体验不符合预期（应优先展示任务 title）。

## 目标

1. toast notice 在任务 title 可用时，优先展示任务 title，而不是 id。
2. 若 title 不可用（空/缺失/未加载），回退展示截断 id（保持可用性）。
3. 不更改后端 API 与协议，仅调整前端展示文案拼装逻辑。

## 非目标

- 不修改任务状态流转与队列逻辑。
- 不调整 toast 的样式、布局、时长。

## 验收标准

- 当本地任务列表中能找到 `taskId` 对应的 `title` 时：
  - queued：toast 文案包含 title（不再仅包含 id）。
  - scheduled：toast 文案包含 title（不再仅包含 id）。
- 当找不到 title 时：
  - 文案回退为原先的截断 id（8 位）。

## 验证

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`

