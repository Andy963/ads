# ADR-0014: Per-Project Keyed Locks for Cross-Project Parallelism

- Status: Accepted
- Date: 2026-02-03

## Context

ADS Web 目前的执行路径在 `startWebServer` 中创建了单个全局 `AsyncLock`，并在以下场景使用 `runExclusive` 包裹：

- WebSocket：`prompt` / `command` / `task_resume`
- Task Queue：planner / executor 的整个执行

结果是：**不管打开多少个项目（workspaceRoot / project session），所有项目的执行都会被同一把锁串行化**。这会让用户感知到“多个项目只有一个 agent 在排队执行”，严重削弱多项目编排的意义。

同时，我们仍然希望保留一个关键约束：**同一项目内保持串行**，避免多个执行流并发读写同一仓库导致工作目录/patch/任务队列状态互相踩踏。

## Decision

引入按项目（`workspaceRoot`）分片的 keyed lock，并让 WebSocket 与 Task Queue 共享同一把项目锁：

1. 新增 `WorkspaceLockPool`，按 `workspaceRoot`（realpath 归一化）返回对应的 `AsyncLock`
2. WebSocket `prompt` / `command` / `task_resume` 使用 `detectWorkspaceFrom(currentCwd)` 获取 `workspaceRoot`，再通过 `WorkspaceLockPool` 执行 `runExclusive`
3. Task Queue 在 `ensureTaskContext(workspaceRoot)` 时绑定该 `workspaceRoot` 的锁，并在 planner / executor 中使用该锁
4. API 路由不再使用全局锁，而是使用 `taskCtx.lock`（按 workspace 分片），从而实现跨项目并行、同项目串行

## Consequences

- 正向：
  - 不同项目之间可以真正并行执行（并发的 agent turn / task queue run 不再互相阻塞）
  - 同一项目内仍然保持串行，减少并发写导致的仓库状态冲突
  - Task Queue 与交互式会话共享项目锁，避免两条路径同时操作同一 workspace

- 取舍：
  - 并发度上升后，CPU / 网络 / 模型配额消耗会更快，需要用户自行控制并行项目数量
  - 本 ADR 只实现“并行边界正确”，不强制每个项目对应 OS 级独立进程；若需要更强隔离，可在后续演进为 per-project worker process

## Implementation Notes

- Lock pool：`src/web/server/workspaceLockPool.ts`
- WebSocket keyed lock：`src/web/server/ws/handlePrompt.ts`, `src/web/server/ws/handleCommand.ts`, `src/web/server/ws/handleTaskResume.ts`, `src/web/server/ws/server.ts`
- Task Queue keyed lock：`src/web/server/taskQueue/manager.ts`
- API keyed lock：`src/web/server/api/routes/taskQueue.ts`, `src/web/server/api/routes/tasks.ts`, `src/web/server/api/routes/tasks/chat.ts`, `src/web/server/api/handler.ts`, `src/web/server/api/types.ts`

