# ADR 0030: Actions 任务状态对账与 blocked 显式处置

## Status

Accepted

## Context

#432 落地后，返工预算为 3 次、每次失败都会落库到 `action_jobs.attempts_json`。
有界重作状态机因此能稳定收敛到 `blocked`，但 `blocked` 之后没有出口：

- `server/web/server/api/routes/actions.ts` 只暴露 `/cancel` 一个变更端点，
  没有 resume、complete 或 abandon。面板上的 `blocked` 任务只有 Cancel。
- `cancelJob` 同时做了三件事：终止进行中的轮次、把任务置为 `cancelled`、
  `safeResetToDev` 之后重跑 `evaluateQueue`。释放队列的副作用与丢弃任务的
  动作焊死在一起，运营者无法表达「这个任务已经在别处交付完成」。
- `action_jobs` 记录了 `pr_number`，却没有任何代码路径回读 GitHub。
  job `job-1790493001632-427-850f` 的 PR #429 实际已合并，任务却仍停在
  `blocked` 并继续占用队列，直到人工点击 Cancel 才被记为 `cancelled`，
  而交付其实早已发生。

## Decision

### 对账只读，绝不合并

新增 `LaneDispatchBus.reconcileJobsWithGitHub`，在 `evaluateQueue` 判定队列
能否推进之前运行，遍历该项目下所有 `pr_number` 非空且处于非终态的任务，
通过 `gh pr view --json state,mergedAt,baseRefName` 读取真实状态。

判定规则：

- 已合并且 `baseRefName` 等于 `ACTIONS_BASE_BRANCH`：收敛为 `completed`，
  清空 `blocked_at` 与 `error_message`。
- 已合并但 `baseRefName` 是其它分支：不收敛，记录 base 分支不匹配，
  维持原状态继续占用队列。
- 未合并、或读取失败：不做任何改动。

对账不会执行任何合并动作。它只读 GitHub 状态并记录结果。校验 base 分支
是硬性要求：把一个合进其它分支的任务当作完成，等于把队列放行到一个不包含
该变更的基线上，比继续阻塞更糟。

### 处置端点只接受 blocked

新增 `POST /api/actions/jobs/:id/resolve`，请求体为
`{ "action": "resume" | "complete" | "abandon", "note": "..." }`：

| action     | 目标状态  | 语义                                   |
| ---------- | --------- | -------------------------------------- |
| `resume`   | `queued`  | 清零 `rework_count`，保留原分支重新入队 |
| `complete` | `completed` | 任务已在队列之外交付完成              |
| `abandon`  | `failed`  | 有意放弃，`note` 记入 `error_message`  |

任务不在 `blocked` 时端点返回 409 并拒绝。这条限制是刻意的：
`waiting_merge` 及其它状态由确定性后端流水线拥有，手工在刚创建的 PR 上
点「完成」会绕过自动合并与收尾，直接破坏 ADR 0027 确立的确定性交付契约。
面板因此只在 `blocked` 行暴露这三个动作，任何状态都不提供人工 Merge 按钮。

### cancel 只做取消

`cancelJob` 不再触发 `evaluateQueue`。释放队列不再与丢弃任务绑定，
改由 resolve 端点显式承担。`cancelled` 本身是终态，不参与
`server/actions/threePointGate.ts` 的终态门禁，因此下一次常规的
`evaluateQueue` 触发（自动启动定时器或界面「启动执行」）即可推进队列。

### 记录阻塞起点

`action_jobs` 新增 `blocked_at` 列，在进入 `blocked` 时写入、
离开时清空。面板对 `blocked` 行展示已阻塞时长，时长不足一分钟显示
`just now`，更大的值按 `m` / `h m` / `d h` 逐级放大。缺失该列的旧记录
回落到 `updated_at`，避免出现空白。

## Consequences

正面影响：

- PR 已合并且落在 `dev` 的任务会自动收敛并释放队列，不再需要人工介入。
  #427 的历史正是这一类。
- 运营者可以明确区分「已交付」「需要继续」「有意放弃」三种语义，
  不再被迫用 Cancel 抹平一切。
- 合并进了非预期分支的任务被显式拦下，不会把队列放行到缺少变更的基线上。

代价与边界：

- 每次 `evaluateQueue` 都会对带 `pr_number` 的非终态任务发起一次
  `gh pr view`。任务数量增长后这是一次额外的 GitHub API 调用，
  当前串行队列下每次至多命中一个任务，成本可接受。
- `resume` 只改状态并重跑 `evaluateQueue`，不改动工作区。若工作区不
  在 `dev` 且有未提交改动，三点门禁会把任务退回 `queued` 并写明原因，
  由运营者或下一次触发处理。这是刻意的：resolve 不做工作区写入，
  避免丢弃功能分支上的未提交改动。
- 对账不修复「PR 状态与任务状态本就不一致」的成因，只保证二者最终一致。
  合并仍由 `mergeAndCleanupPipeline` 单一路径负责。

## Out of Scope

返工预算与逐次失败历史见 #432。`blocked` 任务占用队列的规则保持不变。
