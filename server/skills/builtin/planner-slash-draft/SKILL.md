---
name: planner-slash-draft
description: Opt-in delivery protocol for the Advisor `/draft` command. Use only when a local paired issue/spec work-item snapshot is explicitly requested before handing one task to the Worker.
---

# Planner `/draft` Delivery Protocol

You are the **Advisor**. `/draft` is an explicit opt-in local snapshot protocol,
not the default project workflow. GitHub Issues and Pull Requests remain the
source of truth for ordinary collaboration. Use this skill only when the user
specifically asks for a local work-item snapshot before delivery.

The discussion may have branched, reversed, or explored dead ends. The local
work item you emit must reflect only the **final agreed state** so the Worker can
read an immutable snapshot when the task is approved.

## Non-negotiable rules

1. **Write the issue and spec first, then the bundle.** Never emit a bundle for
   directories that do not exist on disk.
2. **Exactly one** ` ```ads-tasks ` fenced block per `/draft`, containing
   **exactly one** task. More than one block, or more than one task, is rejected
   by the server and the draft is discarded.
3. **`issueRef` and `specRef` are mandatory paired directory references.** Both
   must be workspace-relative direct children of their roots:
   `docs/issue/<work-item-key>/` and `docs/spec/<work-item-key>/`. The keys must
   be identical. File references such as `docs/spec/foo.md`, absolute paths,
   `..`, and mismatched keys are rejected by the server.
4. **Never restate issue or spec content inside `prompt`.** The directories hold
   the detail. Duplicating it in the prompt guarantees that the handoff can
   diverge.

## Step 1 — write or update the paired work item

Choose one kebab-case `<work-item-key>` that is stable across revisions of the
same feature. Use exactly the same key in both directory names:

- Issue record: `docs/issue/<work-item-key>/README.md`
- Delivery spec: `docs/spec/<work-item-key>/requirements.md`

**Update the existing paired directories when the topic already has one** — do
not create a second key for a revision. The issue record captures the final
Advisor discussion, while the spec turns that decision into an executable
Worker contract.

You have write access to `docs/issue/` and `docs/spec/` only. Use your normal
file tools. Read anything in the project to inform the work item; write nothing
outside those two roots.

Recommended issue structure:

```markdown
# <Issue title>

## Goal
What problem the user sees and what outcome is required.

## Context
Current behaviour, evidence, and the relevant modules.

## Decisions
Final decisions and rejected alternatives, each with its reason.

## Constraints
Safety, compatibility, and scope boundaries.
```

Recommended spec structure:

```text
docs/spec/<work-item-key>/
├── requirements.md
├── design.md
└── implementation.md
```

`requirements.md` must contain the Worker-facing goal and concrete acceptance
criteria. `design.md` records interfaces, invariants, and tradeoffs.
`implementation.md` records ordered implementation stages and verification.
Every file may be shorter for a small change, but `requirements.md` is always
required.

The spec should be self-contained. A Worker with **no access to this
conversation** must be able to implement it from the directory alone.

Use this shape inside `requirements.md`:

```markdown
# <Feature name>

## Goal
What changes for the user, in two or three sentences.

## Acceptance
- [ ] Concrete, checkable condition
- [ ] Tests or commands that must pass

## Out of scope
What this work item deliberately does not cover.
```

### Acceptance commands

Derive verification from the repo's own toolchain — read `package.json`,
`Makefile`, `justfile`, CI config, or whatever this project actually uses, and
name those commands. Never default to npm, and never hardcode npm verification
in a repo built on a different toolchain.

## Step 2 — emit the bundle

```ads-tasks
{
  "version": 1,
  "issueRef": "docs/issue/<work-item-key>",
  "specRef": "docs/spec/<work-item-key>",
  "tasks": [
    {
      "title": "<short imperative title>",
      "prompt": "Implement the delivery spec in full. Read the paired issue and spec directories first, then complete every acceptance criterion. Report verification commands and results."
    }
  ]
}
```

The prompt stays this short on purpose: the issue/spec directories hold the
detail, and repeating it here only creates a second copy that can drift. The
server adds immutable snapshots of both directories when the user approves the
draft.

### How many tasks

**One work item, one spec, one task.** The spec already carries every detail, and
the Worker can work through its stages in a single run. Splitting a spec into a
task per stage costs a round trip each time and buys nothing.

If that task fails, it is re-run as a whole — do not design around partial
completion, and do not add "verify the previous stage landed" preambles.

Split into more than one task only when the spec genuinely covers separate
pieces of work that were discussed together but ship independently. Sequential
stages of one feature are not that case.

## How the snapshot works

At approval time the server runs `git hash-object -w` on every regular file in
both referenced directories and pins the task to those blob SHAs. The Worker
reads those exact contents, so later edits to the issue or spec never silently
change work that was already approved.

This writes into the git object database **without creating a commit** — the
directories do not need to be committed, staged, or otherwise touched up before
approval, and no spec-only commits end up in the project history. Commit them
whenever it suits the project's own workflow.

## Checklist before you emit

- [ ] Paired issue and spec directories written or updated, using one stable key
- [ ] Issue contains `README.md`; spec contains `requirements.md`
- [ ] Issue record reflects the **final** state of Advisor discussion
- [ ] Rejected alternatives recorded under Decisions, not silently dropped
- [ ] Spec has concrete acceptance criteria and verification commands
- [ ] One `ads-tasks` block, normally one task covering the whole spec
- [ ] `issueRef` and `specRef` use the same key and point at directories
- [ ] `prompt` points at the paired directories — it does not restate their contents
