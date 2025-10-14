---
description: Show current workflow status (like git status)
---

# ads.status - Show Workflow Status

Display the status of the active workflow, similar to `git status`.

## ⚠️ IMPORTANT - DO NOT USE GIT

**"like git status" means OUTPUT FORMAT ONLY, NOT git commands!**

- ❌ DO NOT execute `git status`, `git log`, or any git commands
- ❌ DO NOT check git repository state
- ✅ ONLY call ADS MCP tools: `get_workflow_status`
- ✅ Format output to LOOK LIKE git status (visual style only)

This is about **ADS workflows**, not git branches!

## What This Command Does

Shows detailed information about the current workflow:
- Which workflow is active
- All steps and their completion status
- Current step (what you're working on)
- Draft status for each step
- Next recommended actions

## How to Use

### Basic Usage

```
User: /ads.status
```

**IMPORTANT**: You MUST format the output like git status, NOT raw JSON!

Steps:
1. Call MCP tool `get_workflow_status` to get complete status
2. **Parse the JSON and display in the git-like format shown below**
3. Use clear status indicators (✅ 📝 ⚪)
4. Highlight the current step with →
5. Show draft information if applicable

## MCP Tools to Use

### Get workflow status
```json
{
  "tool": "get_workflow_status",
  "arguments": {
    "workspace_path": "<current_directory>"
  }
}
```

## Output Format

**CRITICAL**: Do NOT show raw JSON to the user! Parse the JSON and display in this format:

### Workflow with Progress

```
On workflow: bugfix-login-issue
Template: bugfix
Title: Bug修复: 登录页面重复提交

Steps:
  ✅ report      登录页面重复提交 - Bug报告 (v1, finalized)
  📝 analysis    登录页面重复提交 - Bug分析 (draft, not finalized)
  ⚪ fix         (not created yet)
  ⚪ verify      (not created yet)

→ Current step: analysis
  Status: Draft in progress
  Last updated: 2 minutes ago

Progress: 1/4 steps finalized (25%)

📁 Files:
  docs/specs/bug_7k95gom7/bug_report.md       (v1)
  docs/specs/bug_7k95gom7/bug_analysis.md     (draft)

💡 Next actions:
  - Continue editing analysis: /ads.work analysis
  - Finalize to create fix step: /ads.commit analysis
  - Review bug report: cat docs/specs/bug_7k95gom7/bug_report.md
```

### No Active Workflow

```
❌ No active workflow

💡 To get started:
  - List existing workflows: /ads.branch
  - Create new workflow: /ads.new <type> <title>
  - Switch to workflow: /ads.checkout <workflow>
```

### Completed Workflow

```
On workflow: ddd-user-management
Template: ddd_standard
Title: DDD: 用户管理聚合根

Steps:
  ✅ aggregate       用户管理 - 聚合根 (v2, finalized)
  ✅ requirement     用户管理 - 需求 (v1, finalized)
  ✅ design          用户管理 - 设计 (v3, finalized)
  ✅ implementation  用户管理 - 实现 (v1, finalized)

Progress: 4/4 steps finalized (100% ✓ Complete)

🎉 This workflow is complete!

💡 What's next:
  - Start new related feature: /ads.new ddd_standard "用户权限管理"
  - Fix a bug: /ads.new bugfix "权限检查失败"
  - Switch to another workflow: /ads.checkout <workflow>
```

## Status Indicators

- ✅ **Finalized** - Content is committed as a version
- 📝 **Draft** - Has draft content, not yet finalized
- ⚪ **Not Created** - Step hasn't been created yet (will be auto-created after previous step is finalized)
- → **Current Step** - The step you're actively working on

## Example Interaction

```
User: /ads.status

AI: [Calling get_workflow_status...]

On workflow: bugfix-login-issue
Template: bugfix
Title: Bug修复: 登录页面重复提交

Steps:
  ✅ report      登录页面重复提交 - Bug报告 (v1, finalized)
  📝 analysis    登录页面重复提交 - Bug分析 (draft)
  ⚪ fix         (not created yet)
  ⚪ verify      (not created yet)

→ Current step: analysis
  Status: Draft in progress
  Last updated: 5 minutes ago

  Draft content preview:
  ---
  ## 问题根因

  按钮没有实现防抖或禁用逻辑，导致...
  ---

Progress: 1/4 steps finalized (25%)

💡 Next actions:
  - Continue editing: Let's discuss the analysis
  - Finalize analysis: /ads.commit analysis (will auto-create fix step)

What would you like to do?
```

## When to Use

- Check your current progress in a workflow
- See which step needs attention
- Verify what's been finalized vs. still in draft
- Get suggestions for next actions
- Before finalizing to see the full picture

## Related Commands

- `/ads.work <step>` - Explicitly indicate you're working on a step
- `/ads.commit <step>` - Finalize the current or specified step
- `/ads.branch` - List all workflows and switch context
- `/ads.checkout <workflow>` - Switch to a different workflow

## Important Notes

- **Status is real-time** - Always shows current database state
- **Current step** is updated automatically when you edit or finalize
- **Draft content** is separate from finalized content
- **Auto-creation** - Next step is created automatically when you finalize the current step
- Works only with the **active workflow** - use `/ads.checkout` to switch workflows first
