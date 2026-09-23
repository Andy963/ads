# Acopilot & Actions 架构演进与协同规格说明书 (Technical Spec)

> 状态：**规划就绪 (Task-Ready / RFC)**  
> 目标读者：ADS 核心开发者、实施代理。  
> 关联 ADR：[docs/adr/0014-acopilot-and-actions-architecture.md](adr/0014-acopilot-and-actions-architecture.md)

---

## 0. 架构背景与核心演进动机

### 0.1 现状与痛点
当前 ADS 采用物理双标签页（Advisor 思考顾问 ↔ Worker 执行工友）。该方案虽然隔离了底层运行噪音，但存在以下关键痛点：
1. **人肉传真机**：用户必须在 Advisor 中聊完方案，手动复制 Issue 编号，切换到 Worker 标签页，敲击 "处理 issue #xxx" 发送。
2. **角色命名与权责混淆**：实际研发流程包含“架构与规划”（Acopilot）、“编码与测试”（Developer）以及“客观代码审查”（Reviewer）。原 Advisor / Worker 混淆了泳道载体与角色实体，缺少第一公民级别的 Reviewer。
3. **自我证实偏差（Reviewer 失效）**：Developer 在自己长达数千 Token 的试错与推理上下文中执行自审（Self-Review），模型因自我合理化倾向，几乎必然形式主义地给出 LGTM，无法有效拦截架构偏移或边界竞态。
4. **移动端代码 Diff 的不可读性**：在移动端纵向狭小视口（375px~430px）内展示复杂的 Git Diff 是灾难性的（折行破裂、语法错位、认知负担极高）。移动端只需要高密度的**命令执行日志与测试验证流**，代码 Diff 应当交给 Detached Reviewer 与 GitHub PR 进行审查。
5. **保持随时人工介入 (Human-in-the-Loop)**：如果将 Actions 做成完全拿掉输入框的黑盒流水线，会丧失随时转向与刹车的能力。保留底部输入框，使 Actions 保持为“受控的自主智能体”。

### 0.2 终局架构定位：Acopilot 与 Actions
* **左侧 [Acopilot]**：资深架构副驾（主脑）。支持全功能多轮对话、问题排查、方案推演、自动提工单并一键非阻塞异步派发到队列。
* **右侧 [Actions]**：执行与交付泳道。由 **Developer**（编码执行）与 **Reviewer**（独立盲审）协同构成。
  * **保留现有日志流与底部输入框**：复用 MainChatView 与 MainChatComposerPanel，展示命令执行块、测试输出与阶段摘要，不渲染移动端 Diff 视图；
  * **随时人工干预**：用户可在底部输入框打字注入引导指令（进入执行队列）或随时触发中断（interruptActive）。
* **独立质检 [Reviewer]**：物理隔离的盲审裁判（Detached Clean-room Context）。只基于 Issue 契约、ADR 规范、实际 Diff 与测试结果进行冷血对抗性审计。

---

## 1. 角色定义与泳道交互规格

### 1.1 角色权责矩阵
1. **Acopilot**（原 Advisor）：前台思考顾问，负责需求对齐、代码排查、架构设计、Issue 编写与一键派发。
2. **Developer**（原 Worker）：负责根据 Issue 编写代码、补丁修改、执行测试套件、处理 Review 缺陷打回。
3. **Reviewer**（新增独立角色）：负责在独立干净会话中比对 Issue 要求、架构规范、Git Diff 与测试结果，给出 PASS / REJECT 结构化结论。
4. **Actions 泳道**：容纳 Developer 与 Reviewer 运行的统一执行视口。

### 1.2 主工作区双 Tab 规格
* **Tab 1：Acopilot**
  * 保持完整的自然语言对话视口与底部 MainChatComposerPanel；
  * 工单创建后，提供显式 [ 🚀 派发到 Actions 执行 ] 操作；
  * 点击派发后，调用后端非阻塞接口（< 2ms）将任务推入 action_jobs 队列，Acopilot 本轮对话瞬间结束并提示成功，用户可立即输入下一条对话。
* **Tab 2：Actions**
  * **UI 展现**：完全保留现有的 MainChatView 与底部 MainChatComposerPanel；
  * **日志流核心**：仅高密度展示命令执行块、测试输出、步骤摘要日志，不内嵌移动端无法阅读的代码 Diff 视图；
  * **人工介入通道**：
    - 底部输入框持续可用，用户输入的文字按当前逻辑正常排队执行，作为后续转向指令；
    - 支持随时点击中断按钮中止正在执行的步骤。

### 1.3 设置弹窗：角色配置与模型池规格 (ModelManager.vue)
* **Tab 1：【角色配置 (Roles)】**
  - 顶部单选胶囊切换：[ 🧠 Acopilot | ⚙️ Developer | 🛡️ Reviewer ]；
  - 每个角色绑定：启用模型选择、思考强度 (low / medium / high)、系统提示词与历史版本回滚。
* **Tab 2：【模型池 (Model Catalog)】**
  - 100% 完整保留现有的上游同步能力（从 CPA GET /v1/models 探测与批量导入）。

---

## 2. 数据层与持久化设计 (SQLite Schema)

在 ADS 数据库（state.db）中维护两张核心表：

### 2.1 任务执行队列与流转表：action_jobs

```sql
CREATE TABLE IF NOT EXISTS action_jobs (
  id TEXT PRIMARY KEY,                       -- 格式: job-{timestamp}-{issueId|local}-{hex4}
  project_id TEXT NOT NULL,                  -- 项目绝对路径 (如 /home/andy/repos/ads)
  job_kind TEXT NOT NULL DEFAULT 'github_issue' CHECK(job_kind IN ('github_issue', 'local_prompt')),
  issue_id INTEGER,                          -- GitHub Issue 编号
  issue_title TEXT NOT NULL,                 -- 工单标题快照
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'running', 'verifying', 'reviewing', 'waiting_merge', 'completed', 'failed', 'cancelled'
  )),
  branch TEXT,                               -- 分支名 (codex/issue-276)
  developer_profile_id TEXT,                 -- 指定的 Developer Profile ID
  reviewer_profile_ids_json TEXT NOT NULL DEFAULT '[]', -- 指定的 Reviewer Profile ID 列表
  current_step TEXT,                         -- 当前步骤说明
  steps_json TEXT NOT NULL DEFAULT '[]',     -- 步骤时间线数组 JSON
  review_verdicts_json TEXT NOT NULL DEFAULT '[]', -- 独立盲审报告数组 JSON
  pr_number INTEGER,                         -- 生成的 PR 编号
  pr_url TEXT,                               -- PR 链接
  error_message TEXT,                        -- 异常崩溃信息
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_jobs_lookup ON action_jobs(project_id, status, created_at);
```

### 2.2 角色 Profile 候选池表：role_profiles

```sql
CREATE TABLE IF NOT EXISTS role_profiles (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('acopilot', 'developer', 'reviewer')),
  name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(reasoning_effort IN ('low', 'medium', 'high')),
  system_prompt TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_role_profiles_role ON role_profiles(role, is_enabled);
```

---

## 3. 队列调度、双层状态机与分支检出门禁契约

### 3.1 认知层与控制层双层解耦 (Two-Tier State Machine)
为杜绝概率性大模型幻觉与 Token 浪费，Git 分支合并、同步与收尾操作严禁由 LLM Agent 执行，系统设立明确的双层状态机边界：

1. **认知层 (Cognitive Tier - LLM)**：
   - **Developer**：专注于需求理解、补丁编写与测试用例验证；
   - **Reviewer**：专注于在 Detached Clean-room 独立会话中审计 Diff，输出包含 `PASS` 或 `REJECT` 的结构化 JSON 判词；
   - *绝对禁令*：LLM Agent 严禁执行 Git merge、pull、push、分支删除或工单关闭操作。
2. **控制层 (Deterministic Tier - Node.js LaneDispatchBus)**：
   Reviewer 输出判词后，由控制器接管全生命周期的确定性执行：
   - **判词路由**：若 `REJECT`，检查重做次数（< 2 次则推回 Developer 修复，超限标记 `failed` 并回滚）；若 `PASS`，调用 `gh pr create` 提交 PR；
   - **等待合并态**：任务进入 `waiting_merge` 状态，更新 `pr_number` 与 `pr_url`；
   - **合并与收尾管道**：用户确认（或配置 auto-merge）后，控制器顺序执行硬原子流水线：
     ```bash
     gh pr merge <pr_number> --squash --delete-branch=false
     gh issue close <issue_id>
     git checkout dev
     git pull --ff-only origin dev
     git branch -D codex/issue-<id>
     git push origin --delete codex/issue-<id>
     ```
   - 验证退出码均为 0 后，控制器将状态置为 `completed`，并触发下一任务的检出门禁判定。

### 3.2 串行 FIFO 队列原则
* 项目严格遵循**单一主工作区执行规范，严禁创建独立 Git worktree**；
* 所有开发分支必须基于最新的干净 `dev` 分支检出；
* 为防止多任务分支发散、未提交代码冲突与破坏性合并冲突，`action_jobs` 队列采取**严格串行执行**策略（FIFO Queue）。

### 3.3 下一个任务检出新分支的判定条件（Three-Point Checkout Gate）
当任务 N 在 Actions 泳道中运行完毕后，队列调度器必须严格验证以下三大前置条件全部满足，方可检出新分支开始任务 N+1：

1. **任务终态门禁 (Terminal State Gate)**：
   - 任务 N 的数据库状态必须已跃迁至终态：
     - `completed`：代码完成、测试通过、Reviewer 判定 PASS、PR 已合并、分支已清理；
     - 或 `failed` / `cancelled`：已终止且现场已恢复回 `dev`。
   - 若任务 N 处于 `waiting_merge`（等待人类合并确认）或仍在运行，任务 N+1 绝对保持 `queued` 状态。
2. **工作区物理净空门禁 (Working Tree Cleanliness Gate)**：
   - `git branch --show-current` 必须严格等于 `dev`；
   - `git status --porcelain` 检查受追踪文件必须为空（无任何 staged、unstaged 或未解决冲突文件）。
3. **基线对齐门禁 (Base Branch Synchronization Gate)**：
   - 执行 `git fetch origin dev`，核验本地 `dev` 的 `HEAD` 必须严格对齐远端最新提交（`git rev-parse HEAD == git rev-parse origin/dev`），确保任务 N 的合并提交已完全沉淀到本地基线。

三项核验全部通过后，调度器方可执行：
`git checkout -b codex/issue-<next_id>`
并将任务 N+1 状态置为 `running`。

---

## 4. Detached Clean-Room Reviewer 盲审规范

### 4.1 物理上下文隔离边界
* Reviewer 必须在全新的临时会话（Detached Context）中执行；
* 输入材料严格限定为：
  1. issue: 标题、描述与验收准则；
  2. adrs: 相关架构决策记录；
  3. diff: 最终代码变更 git diff origin/dev...HEAD；
  4. test_report: 本地测试套件运行命令与退出码。
* 严禁将 Developer 的长上下文、中间试错历史或心理活动传入 Reviewer。

### 4.2 判定结论与自愈循环
* Reviewer 输出结构化 JSON（包含 PASS / REJECT 及具体缺陷行号与说明）；
* 若 REJECT，由 Developer 原地进行有界修复（上限 2 次）；
* 若 PASS，进入 PR 提交与合并生命周期。

---

## 5. 关键工程挑战与异常防御矩阵 (Edge Cases & Resilience)

### 5.1 单工作区并发与输入意图区分
* **意图区分规则**：当 Actions 处于 `running` 状态时，底部输入框敲入的内容一律作为当前 Developer 轮次的**实时转向指令 (Steering Context)**；发起全新独立任务一律通过 Acopilot 派发或使用显式前缀命令（如 `/enqueue <prompt>`）；
* **本地脏代码拦截**：调度器检出新分支前若发现工作区存在未暂存/未跟踪修改，状态置为 `blocked_dirty_workspace` 并挂起队列，在 Actions 界面提示用户人工清理或放弃，严禁自动执行破坏性 `git reset --hard`。

### 5.2 外部 Git & GitHub 调用的降级机制
* **无远端本地项目**：若未配置 GitHub remote 或无 `gh` 凭据，控制器自动跳过 PR 阶段，直接在本地将特性分支 fast-forward 合并回 `dev`；
* **分支保护规则拦截**：若目标分支配置了必须通过外部 CI 或必须人工 Approval，`gh pr merge` 失败时控制器将状态安全置为 `waiting_merge_external`，等待外部条件满足或人工在网页端处理；
* **远端基线分叉**：若合并后 `git pull --ff-only` 产生冲突，控制器保留特性分支现场并告警，等待人工解决冲突。

### 5.3 Detached Reviewer 边界与自愈死循环打破
* **超大 Diff 预过滤**：发送给 Reviewer 的 Diff 自动过滤 `package-lock.json`、编译生成物与二进制文件；对超过 800 行的超大改动附带 `git diff --stat` 变更摘要；
* **人工特赦通道 (Human Override)**：达到 2 次重做上限后，状态置为 `review_rejected`，Actions 面板提供 `[ 强制放行提 PR ]` 与 `[ 放弃分支 ]` 操作，将终审裁决权交还人类；
* **显式完工信号契约**：Developer 完工必须通过显式完成工具或状态契约通知控制器，禁止通过自然语言模糊匹配猜测完工状态。

---

## 6. 实施策略：独立 Worktree 研发与 4 阶段拆分 (Phased Implementation)

鉴于本重构跨越底层 SQLite Schema、后台调度总线、Detached 审查引擎以及前端设置与泳道展示，无法在短时间内一次性单步交付。**研发过程明确授权在独立 Git worktree (`.worktrees/issue-277`) 中开展**，保护主目录不受长期未决改动干扰，并拆分为 4 个独立可验证的分期交付：

### Phase 1: 数据层与模型迁移 (Data Layer & Preferences)
* **目标**：在不改动既有 UI 的前提下就绪数据持久化与基准设置；
* **改动范围**：
  - SQLite 表迁移：`action_jobs`、`role_profiles` 与 `role_settings_history`；
  - 客户端偏好版本升级至 2，启动时就地积极迁移 `localStorage` 中的存量泳道配置；
* **验收**：通过全量数据库单元测试与偏好迁移回归测试，以独立 PR 交付。

### Phase 2: 设置弹窗重构 (Frontend Roles & Models Tab)
* **目标**：落地移动端友好的角色配置与模型管理；
* **改动范围**：
  - `ModelManager.vue` 拆分为 Roles 与 Models 双一级 Tab；
  - 顶部单选胶囊 `[ Acopilot | Developer | Reviewer ]`，单角色全屏编辑、系统提示词与历史版本回滚；
  - 完整保留上游 CPA 模型探测与同步功能；
* **验收**：Vitest 客户端组件测试全部通过，以独立 PR 交付。

### Phase 3: Detached Clean-Room Reviewer 盲审子系统 (Review Engine)
* **目标**：落地物理隔离的代码审查裁判；
* **改动范围**：
  - 实现独立审查会话运行器，组装 Issue + ADR + Diff + 测试日志的干净 Payload；
  - 结构化 JSON 判词解析与自愈反馈路由；
* **验收**：针对典型 Diff 与缺陷用例进行 Mock 测试，验证审查判定与防提示词注入能力，以独立 PR 交付。

### Phase 4: Actions 队列、确定性控制器与主工作区整合 (Integration)
* **目标**：串联全链路自动化并完成最终交付；
* **改动范围**：
  - 实现 `LaneDispatchBus` 串行 FIFO 队列与三阶检出门禁；
  - 实现 PR 创建、自动合并、分支清理的确定性流水线；
  - 前端双 Tab 更名与 Acopilot 一键派发触发；
* **验收**：端到端跑通从 Acopilot 派发到 Reviewer 审查及自动合并闭环，关闭 Issue #277。