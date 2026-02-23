# Refactor Tracker

本文件用于持续记录：已阅读/触达模块、可重构点（backlog）、尚未覆盖模块。每次重构落地请同步更新。

最后更新：2026-02-23

## Reviewed / Touched

### Backend (`src/`)

- `src/tasks/executor.ts`：更新 `responding` 流式 `delta` 合并逻辑，兼容累积/增量语义并通过 overlap 去重。
- `src/tasks/queue.ts`：重构（统一 `AbortError` 创建/识别与错误信息提取，降低跨模块中断处理分叉）。
- `src/utils/commandRunner.ts`：重构（抽取子进程 lifecycle：timeout/abort/cleanup，减少 pipe/file 两条路径重复逻辑，并补齐测试覆盖）。
- `src/utils/abort.ts`：新增（统一 `AbortError` 创建/识别：`createAbortError()` / `isAbortError()`，用于跨模块中断语义收敛）。
- `src/utils/logger.ts`：阅读（风格可统一，但当前不作为优先项）。
- `src/utils/flags.ts` / `src/utils/env.ts` / `src/utils/error.ts` / `src/utils/text.ts`：阅读（通用工具）。
- `src/utils/streamingText.ts`：新增（流式文本合并工具：`mergeStreamingText()`）。
- `src/state/database.ts`：阅读（状态库 schema 初始化）。
- `src/storage/migrations.ts`：阅读（迁移列表与末尾示例注释）。
- `src/bootstrap/bootstrapLoop.ts` / `src/bootstrap/worktree.ts` / `src/bootstrap/agentRunner.ts` / `src/bootstrap/review/reviewerRunner.ts`：重构（统一 `AbortError` 语义与实现，减少重复代码）。
- `src/agents/hub.ts` / `src/agents/hub/delegations.ts` / `src/agents/tasks/taskCoordinator.ts` / `src/agents/tasks/taskCoordinator/helpers.ts` / `src/agents/adapters/{codex,claude,gemini}CliAdapter.ts`：重构（统一 `AbortError` 语义与实现，减少重复代码）。

### Frontend (`web/`)

- `web/src/components/TaskDetail.vue`：统一中文 UI 文案，并补齐 `queued` / `paused` 的空态与占位提示。
- `web/src/api/types.ts`：阅读（`TaskStatus`/`Task` 类型）。

### Docs

- `docs/code-review-issues.md`：阅读（部分问题已被后续实现覆盖，但仍可作为回归清单）。
- `docs/spec/20260223-1600-project-wide-refactor-pass-1/`：新增（本轮 refactor spec）。
- `docs/spec/20260223-1700-refactor-command-runner-lifecycle/`：新增（`commandRunner` 去重与测试补齐）。

### Tests

- `tests/utils/streamingText.test.ts`：新增（覆盖累积/增量/overlap/截断输入场景）。
- `tests/utils/commandRunner.test.ts`：更新（覆盖 abort/timeout/maxOutputBytes）。
- `tests/utils/abort.test.ts`：新增（覆盖 `createAbortError()` / `isAbortError()` 默认与自定义 message 语义）。

## Refactor Opportunities (Backlog)

### Correctness / Robustness

- （已处理）`src/tasks/executor.ts`：`event.delta` 合并逻辑已增强，并补充 `tests/utils/streamingText.test.ts` 覆盖。

### Maintainability

- （已处理）`src/utils/commandRunner.ts`：抽取共享 lifecycle，减少 pipe/file 重复并补齐测试。
- （已处理）`src/utils/abort.ts`：集中 `AbortError` 创建/识别，跨模块统一中断语义并减少重复代码。
- `web/src/components/TaskDetail.vue`：文案与 aria-label/title 统一为中文；`queued` / `paused` 等状态在空态与占位提示上需覆盖。

### Performance

- 暂无高置信度的性能瓶颈结论（需结合 profiling/trace/真实 workload 再定优先级）。

## Not Yet Reviewed

### Backend (`src/`)

- `src/agents/`（除 `hub.ts` / `hub/delegations.ts` / `adapters/*CliAdapter.ts` / `tasks/taskCoordinator*` 外）
- `src/attachments/`
- `src/audio/`
- `src/bootstrap/`（除 `bootstrapLoop.ts` / `worktree.ts` / `agentRunner.ts` / `review/reviewerRunner.ts` 外）
- `src/codex/`
- `src/graph/`
- `src/intake/`
- `src/memory/`
- `src/scheduler/`
- `src/skills/`
- `src/state/`（除 `database.ts` / `migrations.ts` 外）
- `src/storage/`（除 `migrations.ts` 外）
- `src/systemPrompt/`
- `src/tasks/`（除 `executor.ts` / `queue.ts` 外）
- `src/telegram/`
- `src/types/`
- `src/utils/`（除已列出的文件外）
- `src/web/`
- `src/workflow/`
- `src/workspace/`

### Frontend (`web/src/`)

- `web/src/app/`
- `web/src/api/`（除 `types.ts` 外）
- `web/src/components/`（除 `TaskDetail.vue` 外）
- `web/src/lib/`
- `web/src/main.ts` / `web/src/App.vue`
- `web/src/__tests__/`
