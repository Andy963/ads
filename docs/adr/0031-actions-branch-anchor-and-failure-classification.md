# ADR 0031: Actions 分支锚点、PR 复用与失败分类

## Status

Accepted

## Context

`server/actions/pipeline.ts` 的 `checkFeatureBranchScope` 用「分支与 dev 的 merge-base
是否等于 dev 当前 tip」判断功能分支是否合法。#433 建分支后 dev 又前进了一个提交，
该判据把这种正常情况判成 "carries commits unrelated to this job"，PR 创建被拒，
文案与事实相反。同一条链路上还有两个问题：`createPullRequest` 不查同分支已有 PR，
重复创建时 `gh` 报错被当成失败，白烧一次返工预算；`buildPrCreateArgs` 不传 `--head`，
PR 的 head 由工作区当前分支推断，工作区被并发会话切走就会开错分支。
`LaneDispatchBus.scheduleRework` 对所有失败一律加一次 `rework_count`，
"No Actions session manager configured" 这类重试永远无效的环境故障也占三次预算，
三次耗尽后才 blocked，并把原因指向开发者。

## Decision

### 用建分支时记录的 base_sha 做锚点

新增 `action_jobs.base_sha`（迁移 29）。`evaluateQueue` 走 `git checkout -b` 成功时记录
`HEAD` 作为该任务的锚点，判定改为「分支的 merge-base 是否等于 `base_sha`」。
dev 后续前进不再影响判定，起点不对的分支仍被拒。返工复用已有分支时保留原锚点，
不覆盖。

`base_sha` 为空时跳过这项检查并放行。迁移前的老 job 没有该值，退回旧判据会把它们
永久卡在同一个坎上；这些分支本就在旧代码下从 dev 建出，实际风险接近零。
不做「未记录锚点」的提示写入：`attempts_json` 是失败账本，塞入非失败条目会污染
`repeated` 判定，结论记在本 ADR。

### PR 先查后建，head 显式传参

`createPullRequest` 在同分支已有 open PR 时直接复用其 number 与 url。判定顺序是
「查已有 PR → 范围检查 → 创建」，返工轮次因此不会因 `gh` 的重复 PR 报错而失败。
`buildPrCreateArgs` 增加 `headBranch`，产出 `--head`。

### 失败先分类，环境故障不占返工预算

新增 `ActionsFailureClass`（`implementation` / `infrastructure`）与纯函数
`classifyActionsFailure`，返回 `rework` / `block-exhausted` / `block-infrastructure`。
`infrastructure` 直接进 `blocked`，不增加 `rework_count`，也不写入 `attempts_json`，
使尝试账本长度始终等于已消耗的返工预算。保持判定的可单测性，不依赖对私有方法的反射。

归为 `infrastructure` 的两类：环境未配置 session manager，以及 PR 创建在 CLI 重试后仍失败。
后者此前走 `scheduleRework`，而 `scheduleRework` 会重新调用 `executeDeveloper`。
走到这一步时代码已经通过验证和 detached review，`gh` 失败与代码无关，重跑只会产出
同样的 diff 并在同处再次失败，一次白烧一整轮 agent token。

改为 `createPullRequestWithRetry` 在 CLI 调用上最多重试 3 次（不产生模型调用），
仍失败则按 `infrastructure` 进 `blocked`，不占返工预算，理由里带上实际尝试次数。

"Developer produced no implementation diff" 暂归 `implementation`。它同时覆盖
「开发者没产出改动」和「工作区被并发会话切走导致读到别的 HEAD」两种情况，
在 `hasCommittedImplementationDiff` 改用 `job.branch` 之前无法可靠区分。

## Consequences

- 分支范围检查不再因 dev 前进误报，PR 创建阶段的确定性拒绝消失。
- 重复 PR 不再消耗返工预算，PR 的 head 不再依赖工作区状态。
- PR 创建失败不再重跑 Developer，瞬时故障在 CLI 层重试，持久故障一次即 blocked。
- 环境故障一次即 blocked，理由指向环境而非开发者，返工预算留给代码缺陷。
- 判定逻辑拆成纯函数，可脱离数据库与 git 直接单测。
- `bus.test.ts` 中「未配置 session manager 时任务进入 running」的断言随契约变更更新。
- Reviewer 的 diff 截断策略不在本 ADR 范围内，另行处理。
