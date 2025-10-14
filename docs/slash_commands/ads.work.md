---
description: Explicitly indicate you're working on a workflow step (optional)
---

# ads.work - Work on a Step

Explicitly indicate which workflow step you're working on. This is **optional** - Claude can usually infer context from your conversation.

## What This Command Does

- Fetches the specified step's current content
- Shows the step's status (finalized/draft)
- Displays parent context for reference
- Updates the "current step" marker
- Prepares you to edit or discuss the step

## When to Use (and When NOT to)

### ✅ Use when:
- You want to explicitly switch focus to a different step
- Starting a new work session and want to see current state
- Claude isn't clear which step you're referring to
- You want to see the step's full context before editing

### ⚠️ Usually NOT needed:
- In continuous conversation - Claude tracks context naturally
- After `/ads.commit` - The next step becomes active automatically
- During normal editing - Just tell Claude what you want to change

## How to Use

### Basic Usage

```
User: /ads.work <step>
```

Where `<step>` is one of the step names for your workflow template:

**Bugfix workflow:**
- `report` - Bug report
- `analysis` - Bug analysis
- `fix` - Bug fix
- `verify` - Bug verification

**DDD Standard workflow:**
- `aggregate` - Aggregate root
- `requirement` - Requirements
- `design` - Design
- `implementation` - Implementation

**Quick Feature workflow:**
- `feature` - Feature description
- `implementation` - Implementation

### Examples

```bash
/ads.work analysis    # Work on bug analysis step
/ads.work design      # Work on design step
/ads.work fix         # Work on bug fix step
```

## MCP Tools to Use

### Get step node information
```json
{
  "tool": "get_step_node",
  "arguments": {
    "step_name": "<step>",
    "workspace_path": "<current_directory>"
  }
}
```

## Output Format

### Step with Finalized Content

```
📍 Working on: analysis (Bug分析)

Status: ✅ Finalized (v1)
Last updated: 10 minutes ago

📄 Current Content (v1):
---
## 问题根因

用户点击登录按钮后，没有实现防抖或禁用逻辑...

## 影响范围评估

- 影响所有登录用户
- 可能导致重复session创建
- 数据库压力增加

## 可能的解决方案

### 方案1：前端按钮禁用
...
---

🔗 Context (Parent Steps):
  1. ✅ report - 登录页面重复提交 - Bug报告 (v1)

💡 What would you like to do?
  - Make changes: Just tell me what to modify
  - Review parent: Show me the bug report
  - Finalize this step: /ads.commit analysis
```

### Step with Draft

```
📍 Working on: fix (Bug修复)

Status: 📝 Draft (not finalized)
Last updated: 2 minutes ago

📄 Draft Content:
---
## 修复方案

在 LoginButton 组件中添加防抖逻辑：

```typescript
const [isSubmitting, setIsSubmitting] = useState(false);

const handleLogin = async () => {
  if (isSubmitting) return;

  setIsSubmitting(true);
  try {
    await loginAPI(credentials);
  } finally {
    setIsSubmitting(false);
  }
};
```
---

🔗 Context:
  1. ✅ report - 登录页面重复提交 - Bug报告 (v1)
  2. ✅ analysis - Bug分析 (v1)

💡 Ready to finalize?
  - Continue editing: Just tell me what to change
  - Finalize and proceed: /ads.commit fix
```

### Step Not Created Yet

```
❌ Step 'fix' hasn't been created yet.

Current workflow status:
  ✅ report      (v1, finalized)
  📝 analysis    (draft, not finalized)
  ⚪ fix         ← You are here (not created)
  ⚪ verify      (not created)

💡 To create the 'fix' step:
  1. Finalize the 'analysis' step first: /ads.commit analysis
  2. The system will automatically create the 'fix' step
```

## Example Interaction

### Example 1: Switching Focus

```
User: /ads.work fix

AI: [Calling get_step_node("fix")...]

📍 Working on: fix (Bug修复)

Status: 📝 Draft
Last updated: 5 minutes ago

Draft Content:
---
## 修复方案

添加按钮防抖逻辑...
---

What would you like to do with this fix?

User: Add error handling and retry logic

AI: Great, I'll update the fix to include error handling and retry logic...
[Updates the draft content with error handling]
```

### Example 2: Natural Conversation (No Command Needed)

```
User: Let's work on the bug analysis now

AI: [Automatically infers you want to work on 'analysis' step]

I'll fetch the analysis step for you.
[Shows current analysis content]

What aspects would you like to analyze?

User: Focus on the root cause and impact

AI: [Updates analysis draft with root cause and impact sections]
```

## Related Commands

- `/ads.status` - See all steps and their status
- `/ads.commit <step>` - Finalize a step
- `/ads.checkout <workflow>` - Switch workflows

## Important Notes

- **Optional Command** - Use only when you need to be explicit
- **Context Tracking** - Claude tracks which step you're discussing naturally
- **Auto-updates** - The "current step" updates when you edit or finalize
- **Step Names** - Must match your workflow template (bugfix: report/analysis/fix/verify, ddd: aggregate/requirement/design/implementation)
- **Parent Context** - Always shows parent steps for reference
- **No Changes Made** - This command only fetches and displays; it doesn't modify anything
