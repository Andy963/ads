# ADS 实施计划模板

> 使用说明：依据三步流程逐项拆解工作，确保身份/能力/规则更新、提示词结构调整以及验证闭环全部落地。若某字段不适用，可填 `N/A`。

## 准备事项
- [ ] 对照最新需求/设计确认身份、能力、规则无缺漏。
- [ ] 明确受影响的文件与自动化入口（如配置、脚本、模板）。
- [ ] 约定验证方式与负责人，确保有据可查。

## 阶段任务

### 阶段一：Step 1 背景与意图
- [ ] T{编号}-1：整理背景与目标
  - 负责人：{owner}
  - 交付物：更新后的`系统身份`与`目标`段落
  - 步骤：
    1. 收集输入（{source}）
    2. 草拟草稿并征求反馈
  - 验证清单：
    - [ ] 背景、目标、范围、干系人完整
    - [ ] 相关依赖或合规链接齐全
- [ ] T{编号}-2：校验行为规则
  - 负责人：{owner}
  - 步骤：核对安全限制、拒绝策略、隐私处理
  - 验证清单：
    - [ ] 敏感话题拒绝策略明确
    - [ ] PII 示例均转为占位符

### 阶段二：Step 2 方案与计划
- [ ] T{编号}-3：设计提示词结构
  - 负责人：{owner}
  - 任务说明：更新身份/能力/规则/风格段落与系统信息
  - 命令 / 脚本：`{command_or_script}`
  - 验证清单：
    - [ ] 所有段落均有明确标题与内容
    - [ ] 响应风格符合语气与结构要求
- [ ] T{编号}-4：交互流程与工具策略
  - 步骤：
    1. 描述三步互动流程
    2. 明确工具、命令与平台约束
  - 验证清单：
    - [ ] CMD/PowerShell 示例准确
    - [ ] 自动化钩子策略与限制记录完整

### 阶段三：Step 3 实施与收尾
- [ ] T{编号}-5：更新文件与配置
  - 涉及文件：{file_list}
  - 步骤：
    - 编辑模板/脚本
    - 自检语法与格式
  - 验证清单：
    - [ ] 所有修改通过 lint/格式校验（如适用）
    - [ ] 文档链接与引用有效
- [ ] T{编号}-6：验证与回归
  - 命令 / 测试：`{test_command}`
  - 验证清单：
    - [ ] 核对测试结果或日志
    - [ ] 汇总用户或评审反馈
- [ ]* T{编号}-7：回滚与复盘（可选）
  - 触发条件：{rollback_trigger}
  - 步骤：
    1. 执行回滚脚本 ` {rollback_script} `
    2. 记录根因与改进措施
  - 验证清单：
    - [ ] 回滚完成并通知相关方
    - [ ] 复盘结论归档

## 状态追踪
- 记录方式：{tracking_tool}
- 更新频率：{update_frequency}
- 风险与阻塞：{risk_log}

## 变更记录
- {date}：{change_summary}（责任人：{author}）
# Implementation Plan Template

> 使用说明：本模板用于把需求/设计拆解为可执行任务列表。建议先补充“使用指南”中的准备步骤，再为每个任务块填充字段。可复制任务块以覆盖更多项；若某字段不适用，用 `N/A` 替代以明确无需处理。

## Usage Guide
1. **梳理任务范围**：对照需求与设计文档列出所有交付项，确认先后顺序与依赖。
2. **拆分为具体任务**：确保每个任务可在 1-2 天内完成，并对应唯一负责人。
3. **填写字段**：按照下方 Field Reference 说明补充任务元信息、步骤、命令与验证内容。
4. **同步状态**：日常更新 `Status Notes`，反映进度、阻塞及沟通需求。
5. **完成验证**：任务完成后勾选 `[ ] → [x]`，并在验证清单上标记结果或附证据链接。

## Field Reference
| 字段 | 说明 | 填写建议 |
| ---- | ---- | -------- |
| Task Title | 任务名称 | 尽量动词开头，如“修复…”，“实现…” |
| Owner | 负责人 | 填写个人或小组名称 |
| ETA | 预计完成时间 | 可用具体日期或周次 |
| Branch / PR | 代码出口 | 分支名、PR 链接或 `N/A` |
| Status Notes | 状态注记 | 记录当前进度、阻塞或风险 |
| Steps | 执行步骤 | 以可执行动作描述；可含子任务 |
| Command / Script | 执行命令 | 命令行、脚本路径或配置入口 |
| Verification Checklist | 验收核对 | 需要证明任务完成的检查点 |
| Requirements | 关联需求 | 填写 Requirement IDs 或链接 |
| Optional Tag | 可选任务说明 | 触发条件、收益/成本评估 |

---

- [ ] {task_id}. {task_title}
  - Owner: {owner}
  - ETA: {target_date}
  - Branch / PR: {branch_or_pr}
  - Status Notes: TODO（说明当前状态、阻塞项等）
  - Steps:
    - {step_1} <!-- 精简为可执行动作，例如“更新配置文件” -->
    - {step_2}
  - Command / Script: `{command_or_script}` <!-- 指向脚本路径或命令 -->
  - Verification Checklist:
    - {verification_item_1} <!-- 覆盖核心验收点 -->
    - {verification_item_2}
  - Requirements: {requirement_ids} <!-- 对应需求或设计 ID -->

＞ 提示：此任务块适合关键交付项，若步骤较多可继续添加子 bullet。

- [ ] {task_id}. {task_title}
  - Owner: {owner}
  - ETA: {target_date}
  - Branch / PR: {branch_or_pr}
  - Status Notes: TODO / In Progress / Blocked / Done
  - Steps:
    - {step_1}
    - {step_2}
    - {step_3}
  - Command / Script: `{command_or_script}`
  - Verification Checklist:
    - {verification_item_1}
    - {verification_item_2}
    - {verification_item_3}
  - Requirements: {requirement_ids}

＞ 提示：当任务涉及多人协作或跨系统改动时，建议在 Status Notes 中标注依赖与协同方。

- [ ] {task_id}. {task_title}
  - Owner: {owner}
  - ETA: {target_date}
  - Branch / PR: {branch_or_pr}
  - Status Notes: TODO
  - Steps:
    - {step_1}
    - {step_2}
  - Command / Script: `{command_or_script}`
  - Verification Checklist:
    - {verification_item_1}
  - Requirements: {requirement_ids}

＞ 提示：适用于轻量任务，如文档更新或单文件修复，可将 Steps 控制在 1-2 项。

- [ ]* {task_id}. {task_title} _(Optional: {reason_or_trigger})_
  - Owner: {owner}
  - ETA: {target_date}
  - Branch / PR: {branch_or_pr}
  - Status Notes: TODO
  - Steps:
    - {step_1}
    - {step_2}
  - Command / Script: `{command_or_script}`
  - Verification Checklist:
    - {verification_item_1}
  - Requirements: {requirement_ids}

> Optional 任务通常在特定条件触发时执行，可在 `Optional` 说明中写明触发条件或收益评估。

- [ ] {task_id}. {task_title}
  - Owner: {owner}
  - ETA: {target_date}
  - Branch / PR: {branch_or_pr}
  - Status Notes: TODO
  - Steps:
    - {step_1}
    - {step_2}
    - {step_3}
  - Command / Script: `{command_or_script}`
  - Verification Checklist:
    - {verification_item_1}
    - {verification_item_2}
  - Requirements: {requirement_ids}

＞ 提示：此块可用于“验收”“回归测试”等收尾任务，建议在 Verification 中列出具体测试项、截图或结果链接位置。

- [ ] {task_id}. {task_title}
  - Owner: {owner}
  - ETA: {target_date}
  - Branch / PR: {branch_or_pr}
  - Status Notes: TODO
  - Steps:
    - {step_1}
    - {step_2}
    - {step_3}
  - Command / Script: `{command_or_script}`
  - Verification Checklist:
    - {verification_item_1}
    - {verification_item_2}
    - {verification_item_3}
  - Requirements: {requirement_ids}