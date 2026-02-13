# Spec-Wizard + Auto-Enqueue：需求驱动的端到端任务流水线

> 状态：草案，待审阅

## 1. 背景与问题

当前系统中，从"用户有一个想法"到"任务开始执行"需要经过以下手动步骤：

1. 用户在 planner chat 里描述需求
2. AI 生成 `ads-task-bundle` JSON 代码块
3. 系统将其保存为 `TaskBundleDraft`（草稿）
4. 用户在 Web UI「任务草稿」面板中打开草稿
5. 用户手动点击「批准」或「批准并运行」
6. 系统才真正调用 `TaskStore.createTask` 入队执行

同时，spec 文档（`docs/spec/`）与 TaskBundle 是两套独立的信息载体，没有自动联动：
- spec 需要手动创建三个文件（requirement.md / design.md / implementation.md）
- TaskBundle 的 prompt 与 spec 内容容易脱节
- 讨论阶段产生的决策和约束容易丢失

**核心诉求**：用户只负责"说需求"和"回答澄清问题"，后续的 spec 生成、design/implementation 推导、任务创建和入队全部自动完成。

## 2. 目标（Goals）

### 2.1 Spec-Wizard Skill
- 用户用一句话或一段话描述需求
- Agent 从中提取不确定项，只问 3–8 个必须回答的问题
- 用户回答后，自动生成 `docs/spec/<date>-<slug>/` 下的三件套：
  - `requirements.md`：目标、非目标、约束、验收标准
  - `design.md`：方案、关键决策、风险、兼容性
  - `implementation.md`：步骤、影响文件、测试与验证命令
- design/implementation 中未确认的点显式标注为 `Assumptions` / `Open Questions`

### 2.2 Auto-Enqueue（跳过草稿直接入队）
- 当用户说"转换成任务"时，系统默认**生成 TaskBundle 草稿**（不直接入队）
- 当用户明确说"入队执行/直接入队/自动批准/skip draft"且在同一条用户输入中包含显式口令 `ads:autoapprove` 时，才尝试 `autoApprove: true` 并走高危检测
- 当用户明确说"落草稿"/"先落草稿"/"draft"时，走现有草稿流程
- 当系统检测到高危/不确定性过强时，**强制走草稿**，要求用户确认

### 2.3 Spec 作为 SSOT
- TaskBundle 的 prompt 引用 spec 路径，spec 是唯一事实来源
- 后续如需修改需求/设计，只改 spec 文件，然后重新生成任务

## 3. 非目标（Non-goals）

- 不删除现有草稿机制——草稿作为可选的安全阀保留
- 不修改现有 Workflow 系统（`ads.new`、`ads.commit`、GraphNode）的核心逻辑
- 不实现 spec ↔ draft 的双向同步（本期只做 spec → task 单向派生；双向同步作为后续迭代）
- 不改变 TaskQueue 的执行逻辑（`queue.ts`、`executor.ts` 不动）

## 4. 关键约束（Constraints）

- `ads-task-bundle` JSON 中的 `title` / `prompt` 保持 English-only
- spec 文档正文可以用中文
- 高危检测必须在后端执行（不能仅依赖 skill prompt 提示）
- 向后兼容：现有的 draft → approve 流程必须继续正常工作
- `autoApprove` 只在 `chatSessionId === "planner"` 时生效

## 5. 详细设计

### 5.1 TaskBundle Schema 扩展

在 `src/web/server/planner/taskBundle.ts` 的 `taskBundleSchema` 中新增字段：

```typescript
export const taskBundleSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).optional(),
  runQueue: z.boolean().optional(),
  autoApprove: z.boolean().optional(),          // New
  insertPosition: z.enum(["front", "back"]).optional(),
  specRef: z.string().optional(),               // New: relative path to the spec dir
  tasks: z.array(taskBundleTaskSchema).min(1),
}).passthrough();
```

- `autoApprove`：当为 `true` 时，系统跳过草稿直接创建任务并入队
- `specRef`：记录该 bundle 派生自哪个 spec（如 `docs/spec/20260211-xxx/`），用于溯源

### 5.2 handlePrompt.ts 核心变更

当前逻辑（`chatSessionId === "planner"` 分支）：
```
Extract ads-task-bundle blocks -> persist as TaskBundleDraft -> notify frontend
```

变更后逻辑：
```
Extract ads-task-bundle blocks -> check autoApprove
  |- autoApprove !== true -> existing draft flow (unchanged)
  `- autoApprove === true -> risk detection
       |- high risk -> degrade to draft + notify frontend
       `- low risk -> createTask + enqueue + notify frontend
```

**直接入队的实现**：复用 `taskBundleDrafts.ts` 路由中 `approve` 端点的核心逻辑（`normalizeCreateTaskInput` → `taskStore.createTask` → `promoteQueuedTasksToPending` → `taskQueue.resume`），提取为共享函数：

```typescript
// New file: src/web/server/planner/taskBundleApprover.ts
export interface AutoApproveResult {
  ok: boolean;
  createdTaskIds: string[];
  degradedToDraft: boolean;
  degradeReason?: string;
}

export async function autoApproveBundle(args: {
  bundle: TaskBundle;
  taskCtx: TaskContext;
  authUserId: string;
  deps: ApiSharedDeps;
  url: URL;
}): Promise<AutoApproveResult>;
```

### 5.3 高危检测逻辑

新建 `src/web/server/planner/riskDetector.ts`：

```typescript
export interface RiskDetectionResult {
  isHighRisk: boolean;
  reasons: string[];
}

export function detectBundleRisk(bundle: TaskBundle): RiskDetectionResult;
```

检测规则（扫描 bundle 中所有 task 的 `title` + `prompt`）：

| 类别 | 匹配关键词/模式 | 风险说明 |
|------|-----------------|----------|
| 破坏性操作 | `delete`, `drop`, `truncate`, `force push`, `reset --hard`, `rm -rf`, `migration` (含 down/rollback) | 不可逆操作 |
| 协议/Schema 变更 | `schema`, `protocol`, `public api`, `breaking change`, `database migration` | 影响面大 |
| 安全敏感 | `auth`, `permission`, `secret`, `token`, `credential`, `password` | 安全风险 |
| 不确定性 | prompt 中包含 `TODO`, `TBD`, `Open Question`, `Assumption`, `not sure`, `unclear` | 需求未闭合 |

当 `reasons.length > 0` 时，强制降级为 draft。

### 5.4 前端变更

#### 5.4.1 新 WebSocket 消息类型

后端在直接入队成功后，发送：
```typescript
sendToChat({
  type: "task_bundle_auto_approved",
  createdTaskIds: string[],
  specRef: string | null,
  taskTitles: string[],
});
```

降级为草稿时，发送现有的 `task_bundle_draft` 消息，附加降级原因：
```typescript
sendToChat({
  type: "task_bundle_draft",
  action: "upsert",
  draft,
  degradeReason: "High risk detected: database migration",
});
```

#### 5.4.2 wsMessage.ts

新增对 `task_bundle_auto_approved` 的处理：
- 在聊天区域显示一条系统消息："✅ N 个任务已直接入队执行"
- 触发任务列表刷新

对 `task_bundle_draft` 消息，如果携带 `degradeReason`：
- 草稿面板正常展示
- 额外显示一条警告消息："⚠️ 已降级为草稿：{degradeReason}，请确认后手动批准"

#### 5.4.3 TaskBundleDraftPanel.vue

- 草稿条目中如果有 `degradeReason`，显示黄色警告标签
- 无其他大改，现有的编辑/批准/删除流程保持不变

### 5.5 TaskBundle 协议支持

`TaskBundle` JSON block schema 支持 `autoApprove` 参数：
- 当 `autoApprove=true` 且通过高危检测 → 直接入队，返回 `createdTaskIds`
- 否则 → 走现有 draft 流程

### 5.6 Skill 层

#### 5.6.1 spec-wizard（新建）

位置：`.agent/skills/spec-wizard/SKILL.md`

职责：
1. 接收用户的需求描述
2. 提出 3–8 个澄清问题（只问必须回答的）
3. 用户回答后，生成 `docs/spec/<yyyymmdd>-<hhmm>-<slug>/` 下三个文件
4. design/implementation 中未确认的点标注为 Assumptions / Open Questions
5. 生成完毕后，如用户期望端到端自动流转，可直接输出 TaskBundle 草稿（默认不自动入队）

实现要点（关键）：
- 通过 assistant 输出 `<<<spec ... >>>` YAML block 携带三文件内容，由后端自动落盘
- 后端在落盘时自动创建 workflow spec（等价自动走 `/ads.new`），用户无需手工执行命令

模板结构（每个文件 10–20 行 bullets，不写长篇大论）：

**requirements.md**：
```markdown
# <Title> - Requirements

## Goal
## Non-goals
## Constraints
## Acceptance Criteria
## Verification
```

**design.md**：
```markdown
# <Title> - Design

## Approach
## Key Decisions
## Risks
## Compatibility
## Assumptions / Open Questions
```

**implementation.md**：
```markdown
# <Title> - Implementation

## Steps
## Files Touched
## Tests & Verification
## Assumptions / Open Questions
```

#### 5.6.2 spec-to-task（更新现有）

更新 `.agent/skills/spec-to-task/SKILL.md`：

变更点：
- 默认输出的 `ads-task-bundle` JSON 不包含 `autoApprove`（走草稿流程）
- 当用户明确说"入队执行/直接入队/自动批准/skip draft"时，才输出 `autoApprove: true`
- 当用户说"落草稿"时，确保不设 `autoApprove`（走现有 draft 流程）
- `specRef` 填入 spec 目录路径
- prompt 结构中增加 `Spec Reference: docs/spec/xxx/` 一行

## 6. 影响文件清单

### 后端
| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/web/server/planner/taskBundle.ts` | 修改 | schema 新增 `autoApprove`、`specRef` |
| `src/web/server/planner/riskDetector.ts` | **新建** | 高危检测逻辑 |
| `src/web/server/planner/taskBundleApprover.ts` | **新建** | 提取直接入队的共享逻辑 |
| `src/web/server/ws/handlePrompt.ts` | 修改 | planner 分支增加 autoApprove 路径 |
| `src/web/server/api/routes/taskBundleDrafts.ts` | 修改 | approve 核心逻辑提取到 `taskBundleApprover.ts`，本文件改为调用 |

### 前端
| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `web/src/api/types.ts` | 修改 | `TaskBundle` 类型新增 `autoApprove`、`specRef`；`TaskBundleDraft` 新增 `degradeReason` |
| `web/src/app/projectsWs/wsMessage.ts` | 修改 | 处理 `task_bundle_auto_approved` 消息 |
| `web/src/components/TaskBundleDraftPanel.vue` | 修改 | 降级草稿显示警告标签 |

### Skill
| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `.agent/skills/spec-wizard/SKILL.md` | **新建** | 需求澄清 + 生成 spec 三件套 |
| `.agent/skills/spec-to-task/SKILL.md` | 修改 | 默认 `autoApprove: true`，支持 `specRef` |

### 测试
| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `tests/web/taskBundle.test.ts` | 修改 | 测试 schema 扩展（`autoApprove`、`specRef`） |
| `tests/web/riskDetector.test.ts` | **新建** | 高危检测单元测试 |
| `tests/web/taskBundleApprover.test.ts` | **新建** | 直接入队逻辑单元测试 |
| `web/src/__tests__/task-bundle-drafts-panel.test.ts` | 修改 | 降级草稿 UI 测试 |

## 7. 数据流总览

```
User describes requirement
  |
  v
Agent clarifies (spec-wizard)
  |
  v
User answers (or assumptions)
  |
  v
Assistant emits <<<spec ... >>> YAML block
  -> backend creates docs/spec/<yyyymmdd>-<hhmm>-<slug>/ and writes:
       - requirements.md
       - design.md
       - implementation.md
  |
  v
Assistant emits ads-task-bundle JSON (default: draft; autoApprove requires passphrase ads:autoapprove)
  |
  v
handlePrompt.ts extracts bundle
  |
  |- autoApprove=true (passphrase present) -> riskDetector.detectBundleRisk()
  |     |- high risk -> draft (degraded)
  |     `- low risk -> createTask + enqueue
  |
  `- autoApprove not true -> upsertTaskBundleDraft (unchanged)
```

## 8. 向后兼容

- `autoApprove` 为 optional，默认 `undefined`，现有所有 bundle 不受影响
- 现有的 draft → approve 流程完全保留
- 前端对 `task_bundle_auto_approved` 消息类型做兜底：不认识就忽略
- `specRef` 为 optional，不影响现有 bundle

## 9. 验收标准

1. **Spec-Wizard 流程**：用户描述需求 → agent 提问 → 用户回答 → `docs/spec/` 下生成三个文件，内容符合模板
2. **默认草稿**：用户说"转换成任务" → bundle 不带 `autoApprove` → 草稿面板可见，且不会自动入队
3. **显式入队**：用户说"入队执行/直接入队/自动批准/skip draft"且包含口令 `ads:autoapprove` → bundle 带 `autoApprove: true` → 通过高危检测后任务直接入队
4. **落草稿**：用户说"落草稿" → bundle 不带 `autoApprove` → 走现有草稿流程
5. **高危降级**：bundle prompt 包含高危关键词 → 即使 `autoApprove: true` 也降级为草稿，前端显示降级原因
6. **向后兼容**：现有的 planner → draft → approve 流程不受任何影响

## 10. 验证命令

```bash
npx tsc --noEmit           # Type check
npm run lint               # lint
npm test                   # Run tests
npm run build              # Build
```
