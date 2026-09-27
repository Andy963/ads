# ADR 0030: Actions 任务状态对账与 blocked 显式处置

## Status

Accepted

## Context

#432 把返工预算提高到 3 次并逐次落库后，有界重作状态机稳定收敛到 `blocked`，
但 `blocked` 没有出口：`actions.ts` 只暴露 `/cancel`；`cancelJob` 把终止轮次、置为
`cancelled`、重跑 `evaluateQueue` 焊在一起，运营者无法表达「该任务已在别处交付完成」；
`action_jobs` 记录了 `pr_number` 却无人回读 GitHub。job `job-1790493001632-427-850f`
的 PR #429 实际已合并，任务仍停在 `blocked` 占用队列，直到人工点 Cancel 被记为
`cancelled`，而交付早已发生。

## Decision

### 对账只读，绝不合并

新增 `LaneDispatchBus.reconcileJobsWithGitHub`，在 `evaluateQueue` 判定队列能否推进
之前运行，遍历该项目下 `pr_number` 非空且处于非终态的任务，用
`gh pr view --json state,mergedAt,baseRefName` 读真实状态。已合并且 base 等于
`ACTIONS_BASE_BRANCH` 收敛为 `completed` 并清空 `blocked_at` 与 `error_message`；
已合并但 base 是其它分支则不收敛、记录 base 不匹配并维持原状态；未合并或读取失败
不做任何改动。

校验 base 分支是硬性要求：把合进其它分支的任务当作完成，等于把队列放行到一个
不包含该变更的基线上，比继续阻塞更糟。

### 处置端点只接受 blocked

新增 `POST /api/actions/jobs/:id/resolve`，请求体 `{ action, note }`：

| action     | 目标状态   | 语义                                    |
| ---------- | ---------- | --------------------------------------- |
| `resume`   | `queued`   | 清零 `rework_count`，保留原分支重新入队 |
| `complete` | `completed`| 任务已在队列之外交付完成               |
| `abandon`  | `failed`   | 有意放弃，`note` 记入 `error_message`   |

非 `blocked` 状态返回 409。这条限制是刻意的：`waiting_merge` 及其它状态由确定性
后端流水线拥有，手工点「完成」会绕过自动合并与收尾，破坏 ADR 0027 的确定性交付
契约。面板因此只在 `blocked` 行暴露这三个动作，任何状态都不提供人工 Merge 按钮。

### cancel 只做取消

`cancelJob` 不再触发 `evaluateQueue`，释放队列改由 resolve 端点显式承担。`cancelled`
是终态，不参与 `threePointGate.ts` 的终态门禁，下一次常规评估即可推进。

### 记录阻塞起点

`action_jobs` 新增 `blocked_at` 列，进入 `blocked` 时写入、离开时清空。面板对
`blocked` 行展示阻塞时长，不足一分钟显示 `just now`，更大值按 `m` / `h m` / `d h`
逐级放大，旧记录回落到 `updated_at`。

## Consequences

PR 已合并且落在 `dev` 的任务会自动收敛并释放队列。运营者可以区分「已交付」
「需要继续」「有意放弃」，不再被迫用 Cancel 抹平一切。合进非预期分支的任务被
显式拦下，不会把队列放行到缺少变更的基线上。

代价：每次 `evaluateQueue` 都会对带 `pr_number` 的非终态任务发起一次 `gh pr view`，
串行队列下每次至多命中一个任务，成本可接受。`resume` 不写工作区，若工作区不在
`dev` 且有未提交改动，三点门禁会把任务退回 `queued` 并写明原因。对账只保证 PR 状态
与任务状态最终一致，合并仍由 `mergeAndCleanupPipeline` 单一路径负责。

## Out of Scope

返工预算与逐次失败历史见 #432。`blocked` 占用队列的规则保持不变。
