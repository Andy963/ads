---
description: Finalize a workflow step and trigger automatic progression (like git commit)
---

# ads.commit - Finalize and Progress

Finalize a workflow step and automatically create the next step, similar to `git commit`.

## ⚠️ IMPORTANT - DO NOT USE GIT

**"like git commit" means CONCEPT ONLY, NOT git commands!**

- ❌ DO NOT execute `git commit`, `git add`, or any git commands
- ❌ DO NOT commit to git repository
- ✅ ONLY call ADS MCP tools: `finalize_step`
- ✅ "Commit" means finalize/version a workflow step in ADS

This is about **ADS workflow finalization**, not git commits!

## What This Command Does

When you finalize (commit) a step:

1. ✅ **Creates a version snapshot** - Saves the current content as a permanent version
2. 📁 **Saves to file system** - Writes the finalized content to markdown files
3. 🔄 **Auto-creates next step** - Automatically generates the downstream step
4. 🤖 **Triggers AI generation** (optional) - AI can pre-fill the next step's content
5. ➡️ **Updates current step** - Moves focus to the newly created step

## How to Use

### Basic Usage

```
User: /ads.commit <step>
```

**IMPORTANT**: You MUST format the output in a user-friendly way, NOT raw JSON!

Or commit the current step implicitly:

```
User: /ads.commit
```

### Examples

```bash
/ads.commit analysis    # Finalize analysis step
/ads.commit fix         # Finalize fix step
/ads.commit            # Finalize current step
```

## MCP Tools to Use

### Finalize a step
```json
{
  "tool": "finalize_step",
  "arguments": {
    "step_name": "<step>",
    "change_description": "<optional_description>",
    "workspace_path": "<current_directory>"
  }
}
```

## Workflow Progression Rules

After you commit a step, the next step is automatically created:

### Bugfix Workflow
```
report (commit) → analysis (created)
analysis (commit) → fix (created)
fix (commit) → verify (created)
verify (commit) → workflow complete ✓
```

### DDD Standard Workflow
```
aggregate (commit) → requirement (created)
requirement (commit) → design (created)
design (commit) → implementation (created)
implementation (commit) → workflow complete ✓
```

### Quick Feature Workflow
```
feature (commit) → implementation (created)
implementation (commit) → workflow complete ✓
```

## Output Format

**CRITICAL**: Do NOT show raw JSON to the user! Parse the JSON and display in this format:

### Successful Commit with Auto-Progression

```
✅ Committed 'analysis' as v1

📁 Saved to: docs/specs/bug_7k95gom7/bug_analysis.md

🔄 Workflow Progress:
  ✅ report      登录页面重复提交 - Bug报告 (v1)
  ✅ analysis    登录页面重复提交 - Bug分析 (v1) ← Just committed
  📝 fix         登录页面重复提交 - Bug修复 (draft, newly created)
  ⚪ verify      (not created yet)

🎯 Next Step: fix (Bug修复)

The 'fix' step has been created with a template. Let's work on the fix:

💡 What would you like to do?
  - Start working on fix: Let's discuss the fix approach
  - Review analysis: Show me what we just committed
  - See full status: /ads.status
```

### Commit Without Draft

```
❌ Cannot commit 'analysis' - No draft content to finalize

Current status:
  ✅ report      (v1, finalized)
  ✅ analysis    (v1, finalized) ← Already committed
  ⚪ fix         (not created yet)

💡 The 'analysis' step is already finalized. To make changes:
  1. Edit the analysis: Let's update the analysis
  2. Then commit again: /ads.commit analysis
```

### Final Step Committed (Workflow Complete)

```
✅ Committed 'verify' as v1

📁 Saved to: docs/specs/bug_7k95gom7/bug_verify.md

🔄 Workflow Progress:
  ✅ report      登录页面重复提交 - Bug报告 (v1)
  ✅ analysis    登录页面重复提交 - Bug分析 (v1)
  ✅ fix         登录页面重复提交 - Bug修复 (v1)
  ✅ verify      登录页面重复提交 - Bug验证 (v1) ← Just committed

🎉 Workflow Complete! All steps finalized.

📁 All documentation saved to: docs/specs/bug_7k95gom7/

💡 What's next?
  - Start a new workflow: /ads.new <type> <title>
  - Review this workflow: /ads.status
  - Switch to another workflow: /ads.checkout <workflow>
```

## Example Interaction

### Example 1: Commit and Progress

```
User: /ads.commit analysis

AI: [Calling finalize_step("analysis")...]

✅ Committed 'analysis' as v1

📁 Saved to: docs/specs/bug_7k95gom7/bug_analysis.md

Version history:
  v1: Initial analysis (just now)

🔄 Workflow Progress:
  ✅ report      登录页面重复提交 - Bug报告 (v1)
  ✅ analysis    登录页面重复提交 - Bug分析 (v1) ← Just committed
  📝 fix         登录页面重复提交 - Bug修复 (draft)
  ⚪ verify      (not created yet)

🎯 Next Step: fix

The 'fix' step has been created. Based on your analysis, I've prepared a template for the fix:

Draft content:
---
## 修复方案

基于分析，建议采用前端防抖方案...
---

Let's refine this fix together. What specific implementation approach would you prefer?
```

### Example 2: Implicit Current Step Commit

```
[User has been working on 'fix' step in conversation]

User: This looks good, let's commit it

AI: [Infers user wants to commit the current step 'fix']

I'll commit the 'fix' step now.

[Calls finalize_step("fix")...]

✅ Committed 'fix' as v1

The fix has been finalized. I've created the 'verify' step.

Would you like to plan the verification approach?
```

## When to Use

- After completing content for a step
- When you're confident the step is ready
- To trigger automatic creation of the next step
- To save a permanent version snapshot
- When you want to progress the workflow

## Version History

Each commit creates a new version:

```
Step: analysis

v1: Initial root cause analysis (2 hours ago)
v2: Added performance impact assessment (1 hour ago)
v3: Included security considerations (just now) ← Current
```

You can always:
- View version history
- Compare versions
- Revert to previous versions (creates a new draft)

## Important Notes

- **Commit is permanent** - Creates an immutable version snapshot
- **Draft is required** - You must have draft content to commit
- **Auto-progression** - Next step is created automatically
- **Current step updates** - Focus shifts to the new step
- **File sync** - Content is saved to `docs/specs/<workflow_id>/`
- **No "uncommitted changes" warning** - Unlike git, you don't need to commit before switching workflows
- **Step-by-step** - You can only commit steps in sequence (can't skip ahead)

## Related Commands

- `/ads.status` - Check what needs to be committed
- `/ads.work <step>` - Review a step before committing
- `/ads.branch` - See progress across all workflows
- `/ads.new <type> <title>` - Start a new workflow after completing current one

## Comparison with Git

| Git | ADS | Description |
|-----|-----|-------------|
| `git commit` | `/ads.commit <step>` | Create a permanent version |
| `git log` | Version history in UI | See commit history |
| `git revert` | Revert to version | Undo changes |
| Auto-push | Auto-save to files | Persist to file system |
| Commit message | Change description | Describe what changed |

Unlike git:
- **No staging area** - Draft is your staging area
- **Auto-progression** - Automatically creates next steps
- **No merge conflicts** - Single-threaded workflow per branch
