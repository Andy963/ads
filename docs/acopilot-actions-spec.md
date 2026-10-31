# Acopilot 与 Actions 协同规格

## 1. 角色与泳道

- 泳道只有 `acopilot` 与 `actions`；角色只有 `acopilot` 与 `reviewer`。
- Acopilot 负责调查、创建 GitHub Issue、实现代码、运行检查并准备 PR，也负责根据评审意见返工。
- Actions 泳道只处理 PR 评审任务。队列任务只能执行只读 Reviewer，不得派发或运行实现 Developer。
- Reviewer 在 Actions 泳道独立审查，不读取 Acopilot 的推理或实现会话；它不能修改文件、分支、提交或 PR。
- 旧 `advisor` / `planner` 泳道仍映射到 Acopilot，旧 `worker` 泳道仍映射到 Actions。迁移会归档旧 Developer 角色配置并取消未完成的旧实现任务，但保留其历史记录。

## 2. 标准工作流

1. Acopilot 调查需求，并先创建英文 GitHub Issue，内容包含 Problem Description、Root Cause Analysis、Scope of Work 与 Acceptance Criteria。
2. 开始修改前，Acopilot 调用 `begin_implementation(issue_id)`，校验当前项目工作区和仓库任务槽。
3. Acopilot 在 `codex/issue-<id>` 分支实现、验证并准备对应 PR。未经用户明确授权，不得推送、合并或部署。
4. PR 创建后，Acopilot 调用 `review_action`。服务端固定 PR、Issue 条件、base/head 提交与相关 ADR，创建 `pull_request_review` 队列任务。
5. Actions 队列按项目串行运行验证命令，再由只读 Reviewer 检查固定的 Issue/ADR、PR diff 与验证报告。任务及进度显示在 Actions 队列和会话中。
6. PASS 或 REJECT 与该任务固定的 PR、base/head、Issue 与 ADR 快照绑定。`review_action` 把结构化结果返回 Acopilot；REJECT 时由 Acopilot 修复并为新提交再次派审。
7. PR 的 head、base、Issue 或所需证据在任务执行期间变化时，任务不得生成权威 PASS/REJECT；必须重新派发当前目标。

## 3. 边界与保证

- Actions 队列仅接受 PR Reviewer 任务；旧实现任务派发路径不恢复。
- Reviewer 只读；它无法写入文件、运行 shell、切换分支、提交、推送、合并或创建 Issue/PR。
- 验证报告与 Issue 条件、相关 ADR、PR 编号和精确 base/head 一同保存。旧 head 或 base 的 PASS 不适用于新目标。
- 每个项目的评审任务串行执行，避免共享工作区上的并发验证或 Reviewer 执行。
- 队列结果通过 Actions 会话持久化并同步展示，同时返回发起该任务的 Acopilot 调用。
- 用户明确授权之前不得合并、关闭 Issue、删除分支或部署。

## 4. 配置前提

- Reviewer 角色必须启用并配置可用模型和系统指令。
- `ADS_REVIEW_TEST_COMMAND` 指定队列评审前的验证命令，默认值为 `npm test`；非 Node 项目应覆盖为适用命令。
- Acopilot 泳道需要保留实现代码所需的工作区写权限；Actions Reviewer 保持只读。

## 5. 失败语义

- GitHub 查询、目标固定、验证命令或 Reviewer 协议失败属于操作失败，不伪装成代码缺陷。
- 只有 Reviewer 返回的合法 REJECT 才表示需要修复代码。
- 任务执行失败、服务重启或目标漂移都不能生成 PASS；Acopilot 应先恢复前置条件，再对当前 PR 重新派审。
