---
description: Switch to a different workflow (like git checkout)
---

# ads.checkout - Switch Workflow

Switch the active workflow to a different one, similar to `git checkout`.

## ⚠️ IMPORTANT - DO NOT USE GIT

**"like git checkout" means CONCEPT ONLY, NOT git commands!**

- ❌ DO NOT execute `git checkout`, `git switch`, or any git commands
- ❌ DO NOT change git branches
- ✅ ONLY call ADS MCP tools: `switch_workflow`
- ✅ "Checkout" means switch active workflow context in ADS

This is about **ADS workflow switching**, not git branch switching!

## What This Command Does

Changes the active workflow context, allowing you to work on a different task without losing your place in other workflows.

After switching:
- The new workflow becomes active
- You can reference steps by name (report, analysis, fix, etc.)
- Previous workflow state is preserved

## How to Use

### Basic Usage

```
User: /ads.checkout <workflow>
```

**IMPORTANT**: You MUST format the output in a user-friendly way, NOT raw JSON!

The `<workflow>` parameter can be:
- **Type keyword**: `bug`, `standard`, `ddd`, `标准`, `修复` (matches by workflow type)
- **Workflow ID**: `bug_report_abc123` (exact match)
- **Workflow title**: `登录页面重复提交` (exact match)
- **Fuzzy title match**: `登录` (partial match)

### Type Keywords (推荐使用)

**Bugfix workflows**:
- `bug`, `bugfix`, `修复`, `bug修复`

**DDD Standard workflows**:
- `ddd`, `standard`, `标准`, `ddd标准`, `ddd_standard`

**Quick Feature workflows**:
- `quick`, `feature`, `快速`, `特性`, `功能`, `quick_feature`

### Examples

```bash
# 通过类型快速切换（推荐）
/ads.checkout ddd                # Switch to DDD workflow
/ads.checkout standard           # Switch to DDD workflow
/ads.checkout bug                # Switch to bugfix workflow
/ads.checkout 标准                # Switch to DDD workflow

# 通过标题匹配
/ads.checkout bugfix-login       # By title (fuzzy)
/ads.checkout 登录                # By Chinese title

# 通过精确 ID
/ads.checkout bug_report_abc123  # By exact ID
```

## Output Format

The MCP tool returns:
```json
{
  "success": true/false,
  "workflow": {...},      // Workflow context (if success)
  "matches": [...],       // Multiple matches (if ambiguous)
  "message": "..."        // User-friendly message
}
```

### Success Response
```
✅ 已切换到工作流: DDD标准开发流程 - 聚合根
   Template: ddd_standard
   Steps: 4 (0 finalized)
   
   可用步骤:
   - aggregate: agg_qrpper7p
   - requirement: req_1q5v8y7c
   - design: des_t8g7wxvr
   - implementation: imp_twq8kbvf
```

### Multiple Matches (Need Clarification)
```
⚠️ 找到 3 个 'bugfix' 类型的工作流，请指定具体的工作流:

  1. Bug修复: 登录重复提交 (ID: bug_7k95gom7)
     进度: 2/4 steps, 50% done
     
  2. Bug修复: 数据丢失问题 (ID: bug_abc123)
     进度: 4/4 steps, 100% done
     
  3. Bug修复: 权限验证错误 (ID: bug_xyz789)
     进度: 1/4 steps, 25% done

💡 使用以下方式切换:
  - 通过标题: /ads.checkout "登录重复提交"
  - 通过 ID: /ads.checkout bug_7k95gom7
```

### Not Found
```
❌ 未找到匹配 'xyz' 的工作流

💡 可用命令:
  - 查看所有工作流: /ads.branch
  - 创建新工作流: /ads.new <type> <title>
```

## MCP Tools to Use

### Step 1: Switch workflow
```json
{
  "tool": "switch_workflow",
  "arguments": {
    "workflow_identifier": "<workflow_name_or_id_or_type>",
    "workspace_path": "<current_directory>"
  }
}
```

### Step 2: Get workflow status (optional)
After switching, show the new workflow's status:
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

### Successful Switch

```
Switched to workflow 'bugfix-login-issue'

📦 Bug修复: 登录页面重复提交
Template: bugfix
Progress: 2/4 nodes finalized (50%)

Steps:
  ✅ report      - 登录页面重复提交 - Bug报告 (v1, finalized)
  📝 analysis    - 登录页面重复提交 - Bug分析 (draft)
  ⚪ fix         - (not created yet)
  ⚪ verify      - (not created yet)

→ Current step: analysis (draft in progress)

💡 Next actions:
  - Continue editing: /ads.work analysis
  - Finalize analysis: /ads.commit analysis
  - View details: /ads.status
```

### Workflow Not Found

If the workflow doesn't exist:

```
❌ Workflow not found: 'xyz'

Available workflows:
  1. bugfix-login-issue      Bug修复: 登录页面重复提交
  2. ddd-user-management     DDD: 用户管理聚合根
  3. quick-feature-export    快速功能: 数据导出

💡 Use /ads.branch to see all workflows
```

## Example Interaction

```
User: /ads.checkout 登录

AI: [Calling switch_workflow with fuzzy match...]

Switched to workflow 'bugfix-login-issue'

📦 Bug修复: 登录页面重复提交
Template: bugfix
Progress: 2/4 nodes finalized (50%)

Steps:
  ✅ report      - 登录页面重复提交 - Bug报告 (v1)
  📝 analysis    - 登录页面重复提交 - Bug分析 (draft)
  ⚪ fix         - (not created yet)
  ⚪ verify      - (not created yet)

→ Current step: analysis

You're now working on the bug analysis. The draft contains:
- Root cause investigation
- Impact assessment
- Proposed solutions

What would you like to do next?
```

## When to Use

- Switch between multiple parallel tasks
- Resume work on a different feature/bug
- Review completed workflows
- Check the status of another workflow

## Fuzzy Matching

The system supports fuzzy matching on workflow titles:

```
Exact workflow title: "用户认证功能需求分析"

These will match:
  /ads.checkout 用户认证       ✓
  /ads.checkout 认证功能       ✓
  /ads.checkout 用户           ✓ (if unique)

These won't match:
  /ads.checkout user           ✗ (English vs Chinese)
  /ads.checkout 支付           ✗ (unrelated word)
```

## Related Commands

- `/ads.branch` - List all workflows to see what you can switch to
- `/ads.status` - Show detailed status after switching
- `/ads.new <type> <title>` - Create a new workflow

## Important Notes

- **Switching preserves state** - Your work in the previous workflow is saved
- **Step names reset** - After switching, step names refer to the new workflow
- **No uncommitted changes warning** - Unlike git, switching doesn't require committing drafts
- **Context stored in** `.ads/context.json`
- **Fuzzy matching** finds the first match - be specific if you have similar titles
