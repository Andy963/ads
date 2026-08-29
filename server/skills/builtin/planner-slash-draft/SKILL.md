---
name: planner-slash-draft
description: Delivery protocol for the Advisor `/draft` command. Use when turning a design discussion into a spec document under docs/spec/ plus exactly one ads-tasks bundle that references it.
---

# Planner `/draft` Delivery Protocol

You are the **Advisor**. `/draft` is the moment a discussion becomes a delivery.
The discussion may have branched, reversed, or explored dead ends. The task you
emit must reflect only the **final agreed state**, and that state must live in a
file — not in the conversation.

## Non-negotiable rules

1. **Write the spec first, then the bundle.** Never emit a bundle for a spec that
   does not exist on disk.
2. **Exactly one** ` ```ads-tasks ` fenced block per `/draft`, containing
   **exactly one** task. More than one block, or more than one task, is rejected
   by the server and the draft is discarded.
3. **`specRef` is mandatory** and must be a workspace-relative path under
   `docs/spec/`. Anything else (absolute paths, `..`, other directories) is
   rejected by the server.
4. **Never restate spec content inside `prompt`.** The prompt points at a
   section; the spec holds the detail. Duplicating them guarantees they diverge.

## Step 1 — write or update the spec

Path: `docs/spec/<slug>.md`, where `<slug>` is kebab-case and stable across
revisions of the same feature. **Update the existing file when the topic already
has one** — a spec is a living document, not an append-only log. Rewrite the
sections the discussion changed and delete what was rejected.

You have write access to `docs/spec/` only. Use your normal file tools. Read
anything in the project to inform the spec; write nothing outside `docs/spec/`.

Recommended structure:

```markdown
# <Feature name>

## Goal
What changes for the user, in two or three sentences.

## Context
Current behaviour, and the files or modules involved.

## Decisions
Choices made during discussion, each with its reason. Record rejected
alternatives here too — it stops them from being re-proposed later.

## Stages
### Stage 1 — <name>
What to change, in which files, and why.

**Acceptance**
- [ ] Concrete, checkable condition
- [ ] Tests or commands that must pass

### Stage 2 — <name>
...

## Out of scope
What this spec deliberately does not cover.
```

Write the spec so a Worker with **no access to this conversation** can implement
it. That is the actual bar: if a stage only makes sense to someone who watched
the discussion, it is underspecified.

### Acceptance commands

Derive verification from the repo's own toolchain — read `package.json`,
`Makefile`, `justfile`, CI config, or whatever this project actually uses, and
name those commands. Never default to npm, and never hardcode npm verification
in a repo built on a different toolchain.

## Step 2 — emit the bundle

```ads-tasks
{
  "version": 1,
  "specRef": "docs/spec/<slug>.md",
  "tasks": [
    {
      "title": "<short imperative title>",
      "prompt": "Implement the \"Stage 1 — <name>\" section of the spec.\n\nScope: only that stage. Do not start later stages.\nAcceptance: the checklist at the end of that section must pass.\nIf the spec and this prompt disagree, follow the spec and say so in your result."
    }
  ]
}
```

The server prepends the pinned spec reference to `prompt` at approval time — do
not write `git show` lines yourself.

### Splitting work across stages

One `/draft` produces one task. For a multi-stage spec, run `/draft` once per
stage, each pointing at its own section. Later stages can note their dependency
in the prompt (`assumes Stage 1 is merged`), but each task must be independently
implementable from the spec text alone.

## How the pin works

At approval time the server runs `git hash-object -w` on `specRef` and pins the
task to the resulting blob SHA. The Worker reads that exact content, so later
edits to the spec never silently change work that was already approved.

This writes into the git object database **without creating a commit** — the
spec does not need to be committed, staged, or otherwise touched up before
approval, and no spec-only commits end up in the project history. Commit it
whenever it suits the project's own workflow.

## Checklist before you emit

- [ ] Spec file written or updated, reflecting the **final** state of discussion
- [ ] Rejected alternatives recorded under Decisions, not silently dropped
- [ ] Every stage has a concrete acceptance checklist
- [ ] Exactly one `ads-tasks` block, exactly one task
- [ ] `specRef` set, under `docs/spec/`
- [ ] `prompt` points at a section — it does not restate the spec
