---
name: spec-wizard
description: "Elicit requirements from user, ask clarifying questions, then auto-generate a spec triplet (requirement.md, design.md, implementation.md) under docs/spec/. Use when user describes a new feature or change and needs a spec created."
---

# Spec Wizard

## Overview

Turn a user's requirement description into a complete spec under `docs/spec/<yyyymmdd>-<slug>/` with three files: `requirement.md`, `design.md`, `implementation.md`.

The user only needs to **describe the requirement** and **answer clarifying questions**. Design and implementation are derived automatically.

## Trigger

Use this skill when:
- User describes a new feature, change, or improvement and wants a spec
- User says "写个 spec" / "生成 spec" / "create spec" / "spec this"
- User finishes a discussion and wants to formalize it

Do NOT use when:
- User wants to convert an existing spec into a task (use `spec-to-task` instead)
- User is asking a general question, not proposing a change

## Workflow

### Step 1: Extract & Clarify

After the user describes the requirement:
1. Summarize your understanding of the goal in 2-3 sentences
2. List **3–8 clarifying questions** — only questions that block spec generation
3. For each question, state what you will assume if the user doesn't answer
4. Do NOT proceed to Step 2 until the user responds

Rules for questions:
- Only ask what you cannot infer from the codebase or conversation
- Group related questions
- Provide default/recommended answers where possible
- Never ask more than 8 questions

### Step 2: Generate Spec Files

After the user answers:
1. Determine the slug: short, hyphenated, English, describing the feature (e.g. `auto-enqueue`, `spec-wizard`)
2. Determine the date prefix: `yyyymmdd` format, today's date
3. Create the directory: `docs/spec/<yyyymmdd>-<slug>/`
4. Write three files using the templates below

Rules for generation:
- Each file should be **10–30 lines of bullets**, not long prose
- `design.md` and `implementation.md` are derived from the requirement + your codebase knowledge
- Any point you are not confident about must be marked as `**Assumption**` or listed under `Open Questions`
- Never silently guess — surface uncertainty explicitly
- Verification commands should always include the project's standard set: `npx tsc --noEmit`, `npm run lint`, `npm test`; add more if the change touches frontend (`npm run build`)

### Step 3: Present & Prompt Next Action

After generating the files:
1. Show the user a brief summary of what was generated (file paths + key points)
2. Remind: "你可以说「转换成任务」来入队执行，或「落草稿」先审阅"

## Templates

### requirement.md

```markdown
# <Title> - 需求

## Goal
- (1-3 bullets: what we want to achieve)

## Non-goals
- (what is explicitly out of scope)

## Constraints
- (technical, compatibility, security constraints)

## Acceptance Criteria
- (concrete, testable conditions for "done")

## Verification
- (commands to verify: npx tsc --noEmit, npm run lint, npm test, etc.)
```

### design.md

```markdown
# <Title> - 设计

## Approach
- (high-level approach in 3-5 bullets)

## Key Decisions
- (why this approach over alternatives)

## Risks
- (what could go wrong)

## Compatibility
- (backward compatibility, migration concerns)

## Open Questions
- (anything not yet confirmed — list explicitly)
```

### implementation.md

```markdown
# <Title> - 实现

## Steps
1. (ordered implementation steps)
2. ...

## Files Touched
- `path/to/file.ts` — what changes

## Tests
- (new tests to add, existing tests to update)

## Verification
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- (additional commands if needed)

## Assumptions
- (anything assumed but not confirmed)
```

## Language Rules

- File content (spec body): 中文 is fine, English is also fine — follow user's preference
- Slug and directory name: English-only, hyphenated
- If the spec will later be converted to a task via `spec-to-task`, the task prompt will be English-only (handled by that skill, not this one)
