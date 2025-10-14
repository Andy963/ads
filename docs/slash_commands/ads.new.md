---
description: Create a new workflow with interactive content collection
---

# ads.new - Create New Workflow

Create a new workflow with complete, structured content through interactive conversation.

## What This Command Does

1. 📋 **Asks for workflow type and title**
2. 💬 **Collects detailed content interactively**
3. 📝 **Builds complete structured content**
4. 🔄 **Creates full workflow with all steps**
5. 📁 **Saves to file system**
6. ✅ **Sets as active workflow**

## Workflow Types

### 1. bugfix - Bug Fix Workflow
Fix a bug through systematic analysis.

**Steps:**
- `report` → Bug report
- `analysis` → Root cause analysis
- `fix` → Fix implementation
- `verify` → Verification and testing

### 2. ddd_standard - DDD Development
Full domain-driven design workflow.

**Steps:**
- `aggregate` → Aggregate root definition
- `requirement` → Requirements analysis
- `design` → Design specification
- `implementation` → Implementation plan

### 3. quick_feature - Quick Feature
Fast-track feature development.

**Steps:**
- `feature` → Feature description
- `implementation` → Implementation

## How to Use

### Basic Usage

```
User: /ads.new <type> <title>
```

### Examples

```bash
/ads.new bugfix "登录页面重复提交"
/ads.new ddd_standard "用户认证"
/ads.new quick_feature "数据导出功能"
```

## Interactive Content Collection

The command will guide you through collecting detailed content based on the workflow type.

### For Bugfix Workflow

Ask these questions **one by one**:

1. **问题描述**: 简要描述这个bug是什么？
2. **复现步骤**: 如何复现这个问题？(步骤列表)
3. **期望行为**: 正常情况下应该怎样？
4. **实际行为**: 实际发生了什么？
5. **影响范围**: 这个bug影响哪些功能或用户？
6. **优先级**: High/Medium/Low?

**Template:**
```markdown
## 问题描述
<user_description>

## 复现步骤
1. <step1>
2. <step2>
3. ...

## 期望行为
<expected>

## 实际行为
<actual>

## 影响范围
<impact>

## 优先级
<priority>
```

### For DDD Standard Workflow

Ask these questions:

1. **领域概念**: 这个聚合根代表什么业务概念？
2. **业务边界**: 它负责哪些业务规则？
3. **核心实体**: 包含哪些主要实体？
4. **业务规则**: 有哪些关键的业务约束？

**Template:**
```markdown
## 领域概念
<domain_concept>

## 业务边界
<boundaries>

## 核心实体
<entities>

## 业务规则
<rules>
```

### For Quick Feature

Ask these questions:

1. **功能描述**: 这个功能做什么？
2. **用户价值**: 为什么需要这个功能？
3. **验收标准**: 如何判断功能完成？

**Template:**
```markdown
## 功能描述
<description>

## 用户价值
<value>

## 验收标准
<acceptance_criteria>
```

## MCP Tools to Use

### Step 1: Create workflow from template

```json
{
  "tool": "create_workflow_from_template",
  "arguments": {
    "template_id": "<workflow_type>",
    "title": "<user_title>",
    "description": "<complete_structured_content>",
    "workspace_path": "<current_directory>"
  }
}
```

### Step 2: Verify workflow is active

The workflow is automatically set as active. You can optionally verify with:

```json
{
  "tool": "get_active_workflow",
  "arguments": {
    "workspace_path": "<current_directory>"
  }
}
```

## Output Format

### Successful Creation

```
✅ Workflow created successfully!

📦 Workflow: 登录页面重复提交
Template: bugfix
Root ID: bug_7k95gom7

📁 Files created:
   ✅ docs/specs/bug_7k95gom7/bug_report.md (with complete content)
   📝 docs/specs/bug_7k95gom7/bug_analysis.md (template, awaiting work)
   📝 docs/specs/bug_7k95gom7/bug_fix.md (template, awaiting work)
   📝 docs/specs/bug_7k95gom7/bug_verify.md (template, awaiting work)

🔄 Workflow Status:
  ✅ report      登录页面重复提交 - Bug报告 (draft, ready to review)
  ⚪ analysis    (will be created after report is committed)
  ⚪ fix         (will be created after analysis is committed)
  ⚪ verify      (will be created after fix is committed)

→ Current step: report

💡 Next Steps:
  1. Review the bug report: /ads.status
  2. Make any edits if needed: Just tell me what to change
  3. Commit to start analysis: /ads.commit report
  4. View in files: cat docs/specs/bug_7k95gom7/bug_report.md

This workflow is now active. Let's work on it!
```

## Example Interaction

```
User: /ads.new bugfix "登录页面重复提交"

AI: Great! I'll help you create a bug fix workflow for "登录页面重复提交".

Let me collect the details:

**1. 问题描述**: 请简要描述这个bug？

User: 用户点击登录按钮后，如果网络慢，多次点击会重复提交请求

AI: Got it. **2. 复现步骤**: 如何复现这个问题？(一步步列出来)

User:
1. 打开登录页面
2. 输入用户名密码
3. 快速连续点击登录按钮3次
4. 可以看到发送了3次请求

AI: **3. 期望行为**: 正常应该怎样？

User: 点击一次后，按钮应该禁用，只发送一次请求

AI: **4. 实际行为**: 实际发生了什么？

User: 按钮没有禁用，每次点击都发送请求，可能创建重复session

AI: **5. 影响范围**: 这个bug影响哪些功能或用户？

User: 影响所有用户登录，可能导致数据不一致

AI: **6. 优先级**: High/Medium/Low?

User: High

AI: Perfect! Creating bug fix workflow with complete structured content...

[Calls create_workflow_from_template with all collected information]

✅ Workflow created successfully!

📦 Workflow: 登录页面重复提交
Template: bugfix

📁 Files created:
   ✅ docs/specs/bug_7k95gom7/bug_report.md

Bug report content:
---
## 问题描述
用户点击登录按钮后，如果网络慢，多次点击会重复提交请求

## 复现步骤
1. 打开登录页面
2. 输入用户名密码
3. 快速连续点击登录按钮3次
4. 可以看到发送了3次请求

## 期望行为
点击一次后，按钮应该禁用，只发送一次请求

## 实际行为
按钮没有禁用，每次点击都发送请求，可能创建重复session

## 影响范围
影响所有用户登录，可能导致数据不一致

## 优先级
High
---

This workflow is now active! The bug report is ready.

💡 Next steps:
  - Review: /ads.status
  - Make edits if needed: Let's update the bug report
  - Commit to start analysis: /ads.commit report

What would you like to do?
```

## Important Notes

- **Interactive Content Collection** - Don't create empty workflows! Collect real content
- **Complete First Step** - The first step should have complete, meaningful content
- **Template Following** - Use the correct template structure for each workflow type
- **Auto-Active** - Newly created workflows are automatically set as active
- **All Files in One Directory** - All workflow files go to `docs/specs/<workflow_id>/`
- **Step-by-Step Creation** - Later steps are created automatically when you commit earlier steps

## After Creating

The workflow is ready to use immediately:

```bash
/ads.status          # See workflow status
/ads.commit report   # Commit first step (creates next step)
/ads.branch          # See all workflows
```

## Related Commands

- `/ads.status` - Check the new workflow's status
- `/ads.commit <step>` - Start progressing through steps
- `/ads.branch` - List all workflows including the new one
- `/ads.checkout <workflow>` - Switch back if you change context

## Workflow Type Cheat Sheet

| Type | Use Case | First Step | Steps Count |
|------|----------|------------|-------------|
| `bugfix` | Fix a bug | Bug report | 4 |
| `ddd_standard` | DDD development | Aggregate root | 4 |
| `quick_feature` | Fast feature | Feature description | 2 |

Choose based on:
- **bugfix**: When fixing issues
- **ddd_standard**: When building new domain features properly
- **quick_feature**: When adding simple features quickly
