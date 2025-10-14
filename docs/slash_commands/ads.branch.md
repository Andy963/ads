---
description: List all workflows (like git branch)
---

# ads.branch - List All Workflows

Display all workflows in the current workspace, highlighting the active workflow.

## ⚠️ IMPORTANT - DO NOT USE GIT

**"like git branch" means OUTPUT FORMAT ONLY, NOT git commands!**

- ❌ DO NOT execute `git branch`, `git status`, or any git commands
- ❌ DO NOT check git repository branches
- ✅ ONLY call ADS MCP tools: `list_workflows`, `get_active_workflow`
- ✅ Format output to LOOK LIKE git branch (visual style with * marker)

This is about **ADS workflow contexts**, not git branches!

## What This Command Does

Similar to `git branch` OUTPUT FORMAT, this command shows:
- All existing workflows
- Which workflow is currently active (marked with *)
- Progress status for each workflow
- Node count and completion rate

## How to Use

### Basic Usage

```
User: /ads.branch
```

**IMPORTANT**: You MUST format the output like git branch, NOT raw JSON!

Steps:
1. Call MCP tool `list_workflows` to get all workflows
2. Call MCP tool `get_active_workflow` to identify the active one
3. **Parse the JSON and display in the git-like format shown below**

## MCP Tools to Use

### Step 1: List all workflows
```json
{
  "tool": "list_workflows",
  "arguments": {
    "workspace_path": "<current_directory>"
  }
}
```

### Step 2: Get active workflow
```json
{
  "tool": "get_active_workflow",
  "arguments": {
    "workspace_path": "<current_directory>"
  }
}
```

## Output Format

**CRITICAL**: Do NOT show raw JSON to the user! Parse the JSON and display in this format:

```
📋 Workflows in D:/code/my-project

  * bugfix-login        Bug修复: 登录重复提交   (3/4 nodes, 75% done)
    ddd-user-auth       DDD: 用户认证功能       (2/4 nodes, 50% done)
    feature-payment     快速功能: 支付集成      (1/2 nodes, 50% done)

✓ 3 workflows found
* Active workflow: bugfix-login
  Current step: fix (待定稿)
```

### Status Indicators

- `*` - Active workflow (currently working on)
- `✓` - All nodes finalized
- Progress shown as: `(finalized_count/total_count nodes, percentage%)`

## Example Interaction

```
User: /ads.branch

AI: [Calling MCP tools list_workflows and get_active_workflow...]

📋 Workflows in D:/code/ad

  * bugfix-login-issue     Bug修复: 登录页面重复提交    (2/4 nodes, 50% done)
    ddd-user-management    DDD: 用户管理聚合根          (4/4 nodes, 100% ✓)
    quick-feature-export   快速功能: 数据导出           (1/2 nodes, 50% done)

✓ 3 workflows found
* Active: bugfix-login-issue
  Template: bugfix
  Current step: analysis (草稿中)

💡 Use /ads.checkout <workflow> to switch workflows
```

## When to Use

- Check what workflows exist in the project
- See which workflow is currently active
- Get an overview of workflow completion status
- Before switching to a different workflow

## Related Commands

- `/ads.checkout <workflow>` - Switch to a different workflow
- `/ads.status` - Show detailed status of the active workflow
- `/ads.new <type> <title>` - Create a new workflow

## Important Notes

- **Active workflow** is stored in `.ads/context.json`
- If no workflows exist, suggest using `/ads.new` to create one
- Workflow names can be fuzzy-matched when switching
- The active workflow is automatically set when you create a new workflow
