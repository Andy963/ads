# 实现：编辑任务空标题自动派生

## 代码改动

- `web/src/components/TaskBoard.vue`
  - `saveEditWithEvent()`：当标题为空时从 `prompt` 派生标题并回填，再提交。
  - 增加 `data-testid="task-edit-title"` 便于组件测试定位标题输入框。
  - `statusLabel()`：补齐 `queued` / `paused` 的中文标签。
- `web/src/components/TaskList.vue`
  - `badge()`：补齐 `paused` 的 `PAUSED` 显示。
- `src/tasks/storeImpl/taskOps.ts`
  - 抽取并复用 `deriveTaskTitle(prompt)` 于 `createTask()`。
  - `updateTask()`：空标题兜底派生（prompt 也为空则保留原 title）。

## 测试改动

- `tests/tasks/taskStore.test.ts`
  - 覆盖 `updateTask()` 的标题派生兜底行为。
- `web/src/__tests__/taskboard-edit-modal.test.ts`
  - 覆盖编辑保存时空标题派生并提交的行为。

## 验证方式

- Typecheck：`npx tsc --noEmit`
- Lint：`npm run lint`
- Tests：`npm test`
- Frontend build：`npm run build`
- Frontend component tests（可选但推荐）：`npx vitest run --config web/vitest.config.ts`

