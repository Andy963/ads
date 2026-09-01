---
name: planner-slash-draft
description: Delivery protocol for the Advisor `/draft` command. Use when turning a design discussion into exactly one ads-tasks bundle for the Worker, backed by a GitHub reference, a self-contained prompt, or an optional local snapshot.
---

# Planner `/draft` Delivery Protocol

You are the **Advisor**. `/draft` is the moment a discussion becomes a delivery.
The discussion may have branched, reversed, or explored dead ends. The bundle
you emit must reflect only the **final agreed state**. The source of that state
may be a GitHub Issue or PR, a self-contained task prompt, or an optional local
snapshot when the repository workflow benefits from one.

## Non-negotiable rules

1. **Exactly one** ` ```ads-tasks ` fenced block per `/draft`, containing
   **exactly one** task. More than one block, or more than one task, is rejected
   by the server and the draft is discarded.
2. `issueRef` and `specRef` are optional. Use GitHub Issue or PR URLs when the
   repository workflow is GitHub-native, or omit both when the task `prompt` is
   self-contained.
3. When using local snapshots, `issueRef` and `specRef` must be paired
   workspace-relative direct children of their roots:
   `docs/issue/<work-item-key>/` and `docs/spec/<work-item-key>/`. The keys must
   be identical. File references such as `docs/spec/foo.md`, absolute paths,
   `..`, and mismatched keys are rejected by the server.
4. For GitHub-native or prompt-only bundles, put the complete implementation
   intent and acceptance criteria in `prompt`; do not assume the Worker can
   infer missing details from the conversation.
5. For local snapshots, do not restate issue or spec content inside `prompt`.
   The directories hold the detail, and duplicating it can make the handoff
   diverge.

## Step 1 — choose the delivery anchor

Prefer a canonical GitHub Issue or PR URL when the work is already tracked
there. If no remote reference exists, write a self-contained prompt with the
goal, acceptance criteria, constraints, and verification commands. Local paired
directories remain supported when immutable repository-local snapshots are
useful, but they are not required.

### Optional local snapshot

If using local snapshots, choose one kebab-case `<work-item-key>` that is stable
across revisions of the same feature. Use exactly the same key in both directory
names:

- Issue record: `docs/issue/<work-item-key>/README.md`
- Delivery spec: `docs/spec/<work-item-key>/requirements.md`

**Update the existing paired directories when the topic already has one** — do
not create a second key for a revision. The issue record captures the final
Advisor discussion, while the spec turns that decision into an executable
Worker contract.

When `/draft` needs to create or update local snapshots, write only to
`docs/issue/` and `docs/spec/`. Use your normal file tools. Read anything in the
project to inform the work item; write nothing outside those two roots.

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
  "issueRef": "https://github.com/<owner>/<repo>/issues/<number>",
  "tasks": [
    {
      "title": "<short imperative title>",
      "prompt": "Implement the GitHub task in full. Complete every acceptance criterion, run the relevant repository verification commands, and report their results."
    }
  ]
}
```

For prompt-only bundles, omit `issueRef` and `specRef`, and make `prompt`
self-contained. For local snapshots, use the paired directory references and
keep the prompt short; the server adds immutable snapshots of both directories
when the user approves the draft.

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

At approval time, when local paired directories are referenced, the server runs
`git hash-object -w` on every regular file in both directories and pins the task
to those blob SHAs. The Worker reads those exact contents, so later edits to the
issue or spec never silently change work that was already approved. GitHub
references and prompt-only tasks are passed through as task content without a
local snapshot.

This writes into the git object database **without creating a commit** — the
directories do not need to be committed, staged, or otherwise touched up before
approval, and no spec-only commits end up in the project history. Commit them
whenever it suits the project's own workflow.

## Checklist before you emit

- [ ] GitHub reference is canonical, or the task prompt is self-contained
- [ ] If local snapshots are used, paired directories use one stable key
- [ ] If local snapshots are used, issue contains `README.md` and spec contains `requirements.md`
- [ ] Acceptance criteria and verification commands are concrete
- [ ] One `ads-tasks` block, normally one task covering the whole spec
- [ ] Local `issueRef` and `specRef`, when present, use the same key and point at directories
- [ ] A local-snapshot prompt points at the paired directories without restating their contents
