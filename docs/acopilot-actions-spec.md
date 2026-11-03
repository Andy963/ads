# Acopilot 与 Actions 协同规格

## 1. 角色与泳道

- 泳道只有 `acopilot` 与 `actions`；角色只有 `acopilot` 与 `reviewer`。
- Acopilot 负责调查、创建 GitHub Issue、实现代码、运行检查并准备 PR，也负责根据评审意见返工。
- Actions 泳道只处理 PR 评审任务。队列任务只能执行只读 Reviewer，不得派发或运行实现 Developer。
- Reviewer 在 Actions 泳道独立审查，不读取 Acopilot 的推理或实现会话；它不能修改文件、分支、提交或 PR。
- 旧 `advisor` / `planner` 泳道仍映射到 Acopilot，旧 `worker` 泳道仍映射到 Actions。迁移会归档旧 Developer 角色配置并取消未完成的旧实现任务，但保留其历史记录。

## 2. 标准工作流

1. Acopilot 调查需求，并先创建英文 GitHub Issue，内容包含 Problem Description、Root Cause Analysis、Scope of Work 与 Acceptance Criteria。
2. Acopilot 决定任务边界和改动范围。`review_action` 是常驻内置工具；服务端从已认证的会话解析项目、工作区与用户身份。
3. Acopilot 在 `codex/issue-<id>` 分支实现、验证并准备对应 PR。未经用户明确授权，不得推送、合并或部署。
4. PR 创建后，Acopilot 调用 `review_action`。该调用只把 `pull_request_review` 任务入队并立即返回 job id，不等待评审结果；PR、Issue 条件、base/head 提交与相关 ADR 在任务到达队首时固定。
5. Actions 队列按项目串行运行验证命令，再把完整验证报告交给只读 Reviewer，由它结合固定的 Issue/ADR 与 PR diff 评估。命令正常结束后，退出码非零不会阻止 Reviewer 运行。Actions 会话只记录命令、退出码与简短摘要，原始输出保留在任务记录和 Reviewer 输入中。
6. 任务结束后，服务端用统一 `gh` 身份把结构化裁决写成 Issue comment，标记为 `<!-- ads:review-verdict -->`，内容含状态、PR、base/head、job id、摘要与 findings；随后向 Acopilot 泳道写入持久事件 `review_verdict_ready`。Issue comment 是权威记录，事件只是唤醒信号。PASS、REJECT、INCOMPLETE 与该任务固定的 PR、base/head、Issue 与 ADR 快照绑定；REJECT 时由 Acopilot 修复并为新提交再次派审。
7. PR 的 head、base、Issue 或所需证据在任务执行期间变化时，任务不得生成权威 PASS/REJECT；必须重新派发当前目标。

## 3. 边界与保证

- Actions 队列仅接受 PR Reviewer 任务；旧实现任务派发路径不恢复。
- Reviewer 只读；它无法写入文件、运行 shell、切换分支、提交、推送、合并或创建 Issue/PR。
- 验证报告与 Issue 条件、相关 ADR、PR 编号和精确 base/head 一同保存。旧 head 或 base 的 PASS 不适用于新目标。
- 每个项目的评审任务串行执行，避免共享工作区上的并发验证或 Reviewer 执行。
- 队列结果通过 Issue comment 持久化，并以 `review_verdict_ready` 事件唤醒 Acopilot；Actions 会话只展示过程与可读摘要，不承担裁决存档。
- 用户明确授权之前不得合并、关闭 Issue、删除分支或部署。

## 4. 配置前提

- Reviewer 角色必须启用并配置可用模型和系统指令。
- `ADS_REVIEW_TEST_COMMAND` 指定队列评审前的验证命令，默认值为 `npm test`；非 Node 项目应覆盖为适用命令。
- Acopilot 泳道需要保留实现代码所需的工作区写权限；Actions Reviewer 保持只读。

## 5. 失败语义

- GitHub 查询、目标固定、验证命令无法启动、超时或中断，以及 Reviewer 协议失败属于操作失败，不伪装成代码缺陷。
- 验证命令正常结束但退出码非零时，完整报告作为 Reviewer 的评审证据，不构成提前终止任务的理由。
- 只有 Reviewer 返回的合法 REJECT 才表示需要修复代码。
- 任务执行失败、服务重启或目标漂移都不能生成 PASS；Acopilot 应先恢复前置条件，再对当前 PR 重新派审。
- 可恢复的前置条件（head/base 漂移、PR 未同步、Issue 缺少验收标准、工作区未提交）产出 `INCOMPLETE`；真正的运行时崩溃产出 `ERROR`。两者都写入 Issue comment 并唤醒 Acopilot，不再以空裁决收场。
