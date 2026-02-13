# ADS 自举 Review Gate + Skills - 设计

## 1. 直接结论
把“review”做成一个可插拔的 **Review Gate**，挂在自举闭环的“验收通过”之后；reviewer 用独立 `spawn` 启动、只读运行、输出结构化 verdict。reviewer/executor 的行为规范写成可加载的 **Skills**，由 ADS 在运行时注入到 prompt 中。

## 2. 为什么要用“另一个 agent”来 review
用同一个 agent 既执行又 review，常见问题是：
- 自己验证自己：容易忽略隐患、对已走过的路径产生确认偏差
- 上下文污染：执行阶段的细节与未验证假设会干扰 review 视角

独立 reviewer 的价值在于：
- 角色分离：review 更接近“审稿人”，关注风险、契约、边界
- 可控门禁：review verdict 作为一条明确的 gate 信号

## 3. Review Gate 在自举流水线的位置
建议把 review 放在“验收通过”之后、“最终提交”之前：

```text
IterationLoop
  -> install? -> lint -> test
  -> if fail: feedback -> next iteration
  -> if pass: ReviewGate
        -> if approve: commit + done
        -> if reject: feedback(blocking) -> next iteration
```

这样做的好处：
- reviewer 不需要看大量红灯噪音，只看“已经绿了”的最终差异
- executor 修复后仍会再次跑 lint/test，防止“为了改一个 review 点又把 tests 弄红”

## 4. 技术关键点
### 4.1 reviewer 必须只读（硬约束）
只靠 prompt（Skill）不够，必须用技术手段保证：
- 对 worktree：只读 mount 或只读 sandbox
- 禁止写工具：不执行 `apply_patch` / 不执行写命令（通过 tool gating / allowlist）

即使 reviewer 输出“写代码的建议”，也必须由 executor 落盘修改。

### 4.2 reviewer/executor 的“对话沟通”
沟通不是让两个 agent 自由聊天，而是一个固定协议：
- reviewer 输出 `ReviewVerdict`（结构化）
- executor 输出 `ReviewResponse`（结构化），逐条回应 blocking issues
- controller 把 `ReviewResponse` + 最新 diff 再发给 reviewer 复审

限制回合数（例如 2）可以避免“无止境打磨”。

## 5. Skills 设计（prompt 资产化）
### 5.1 Skill 的定位
Skill 是“作业指导书”，用于：
- 固定工作流（先做什么、后做什么）
- 固定输出格式（JSON verdict/response）
- 固定关注点（阻塞项定义、风险等级）

Skill 不能承担：
- 安全隔离（读边界）
- 命令权限控制
- 产物一致性（必须由代码门禁保证）

### 5.2 Skill 的组织形式（推荐：轻量文件型）
复用现有“workspace override + built-in fallback”的模式（类似 `templates/supervisor.md`）：

```text
templates/skills/
  bootstrap-executor.md
  bootstrap-reviewer.md

$ADS_STATE_DIR/workspaces/<workspace_id>/templates/skills/
  bootstrap-executor.md   # optional override
  bootstrap-reviewer.md   # optional override
```

注入顺序建议：
1) System instructions/rules（现有机制）
2) Role skill（executor/reviewer）
3) Run-specific context（goal、diff、验收输出）

### 5.3 Skill 内容大纲（建议）
`bootstrap-executor.md`（要点）：
- 完成定义：lint + test 必须全绿；不要为了“看起来更好”引入无关重构
- 失败时行动：先定位报错、最小修复、补齐测试、再跑验收
- 若 reviewer reject：按 blocking issues 逐条修复并回应

`bootstrap-reviewer.md`（要点）：
- 阻塞项定义：正确性、安全性、契约、明显回归风险、需求偏离
- 非阻塞建议：可以提，但不能阻塞（除非风险等级升高）
- 输出必须是 JSON：`ReviewVerdict`
- 若信息不足：用 `questions[]` 明确要补充什么（不要猜）

## 6. 协议（结构化输出）
### 6.1 ReviewVerdict（reviewer -> controller）
```json
{
  "approve": false,
  "riskLevel": "medium",
  "blockingIssues": [
    {
      "title": "Missing edge case handling for empty input",
      "file": "src/foo.ts",
      "rationale": "Function may throw on empty input and break callers",
      "suggestedFix": "Add guard + unit test"
    }
  ],
  "nonBlockingSuggestions": [
    {
      "title": "Consider extracting helper",
      "file": "src/foo.ts",
      "rationale": "Improves readability"
    }
  ],
  "followUpVerification": [
    "npm test",
    "npm run lint"
  ],
  "questions": []
}
```

### 6.2 ReviewResponse（executor -> controller -> reviewer）
```json
{
  "responses": [
    {
      "title": "Missing edge case handling for empty input",
      "status": "fixed",
      "details": "Added guard in src/foo.ts and test in tests/foo.test.ts"
    }
  ],
  "questionsAnswered": [
    {
      "question": "Do we support empty input?",
      "answer": "Yes, now handled with early return"
    }
  ]
}
```

说明：
- controller 必须校验 JSON 可解析且字段完整；否则要求 agent 重试（最多 1 次），再失败则转人工。

## 7. 与 spawn 的关系（为什么更容易做）
spawn 的工程优势：
- reviewer/executor 两个进程天然隔离：thread history 不共享，降低串扰
- reviewer 可以独立配置为只读 sandbox + 不开 full-auto
- 策略升级时可以重启 executor（减少上下文漂移）

但要强调：隔离边界仍然要靠 hard sandbox（bwrap/docker）提供。

## 8. 失败与降级策略
当出现以下情况时，建议降级为人工接管：
- reviewer 连续两次给出不可解析的 verdict
- reviewer 一直 reject 且 blocking issues 签名不变（疑似要求不明确或项目缺少验收覆盖）
- 出现 flaky tests（同一 commit 下通过/失败摇摆）

交付给人类的材料至少包含：
- 当前 worktree diff/patch
- lint/test 的最后输出
- 最后一次 ReviewVerdict + ReviewResponse

