# ADR-0008: Task Rerun With Workspace Patch Context

- Status: Accepted
- Date: 2026-01-30

## Context

任务执行完成后，常见情况是：

- agent “执行完了”，但产出效果不达预期；
- 为了二次迭代，用户与 agent 需要重新定位“上次到底改了哪些文件/改动是什么”；
- 重新扫描仓库成本高、也容易遗漏关键改动。

因此需要一种机制，能在任务结束时把“本次任务对工作区造成的改动”记录下来，并在“重新执行（新建任务）”时把这份信息传递给 agent 作为上下文。

## Decision

1. **每个任务最多记录一份 workspace patch**
   - 在任务进入 terminal 状态（completed/failed/cancelled）时，将本任务执行过程中的 `file_change` 路径集合与对应的 `git diff patch` 持久化到数据库（task_contexts）。
   - 记录一份即可；删除任务时随任务级联删除。

2. **重新执行采用“创建新任务”**
   - 重新执行不复用原 taskId，避免覆盖历史状态/日志。
   - 新任务通过 `parent_task_id` 关联源任务。

3. **向 agent 传递上一次改动**
   - rerun 时把源任务的 workspace patch 复制到新任务的 `task_contexts`（作为 previous patch 上下文）。
   - 执行新任务时，在 step 1 的 prompt 中注入该 previous patch，减少二次迭代的上下文准备成本。

4. **运行语义**
   - rerun 任务进入队列按规则跑（由前端触发队列 run），不走 single-run。

## Consequences

- 正向：
  - 二次迭代更快：agent 可以直接看到“上一次改了什么”，避免重复读仓库。
  - 历史可追溯：每次尝试是独立任务，保留完整执行记录。

- 负向/风险：
  - patch 基于 git diff，非 git worktree 或无 diff 时只能记录路径集合（或为空）。
  - patch 可能被截断，需要在提示中标记 truncated。

## Implementation Notes

- 记录：
  - `artifact:changed_paths`：执行阶段收集的 file change 路径集合
  - `artifact:workspace_patch`：任务结束时生成的 patch（每任务一份）
- rerun：
  - `/api/tasks/:id/rerun` 创建新任务，并写入 `artifact:previous_workspace_patch`
  - 前端在 completed/failed 场景走 rerun + run queue

