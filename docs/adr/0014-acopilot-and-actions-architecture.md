# ADR 0014: Evolve Dual Lanes into Acopilot and Actions with In-Process Job Bus

## Status

Accepted

## Context

ADS initially solved the problem of long-running command execution and context bloat by physically splitting the workspace into two parallel chat lanes: `Advisor` (read-only planning and diagnosis) and `Worker` (code modification and verification).

While this bifurcation successfully protected the reasoning context from thousands of tokens of compiler warnings and test outputs, it introduced several user-experience and architectural limitations:
1. **Manual Routing Friction**: The user was forced to act as a human router between the two tabs—discussing a task in Advisor, copying the Issue number, switching to the Worker tab, typing "handle issue #X", and waiting for confirmation.
2. **Role & Lane Taxonomy Drift**: The conceptual roles in software development are *planning/architecting* (`Acopilot`), *coding/testing* (`Developer`), and *objective verification* (`Reviewer`). The old `Advisor` / `Worker` terminology conflated lane containers with active roles and lacked a first-class Reviewer identity.
3. **Self-Review Context Contamination**: When the Developer agent performed self-review within its own ongoing conversation context, autoregressive self-justification bias caused the model to routinely rubber-stamp its own code changes rather than detecting subtle edge cases, contract violations, or race conditions.
4. **Mobile UX Realities**: Mobile viewports (375px–430px) cannot meaningfully render code diffs (lines wrap, horizontal scrolls break, cognitive overhead is high). Users need dense, legible execution logs (commands, test results, milestones), while code diffs belong to the detached Reviewer and the final GitHub PR.
5. **Human-in-the-Loop Steering**: Completely removing the input composer turns the execution engine into a rigid, unsteerable black-box. Maintaining an always-available input composer in Actions allows the user to steer, queue instructions, or interrupt at any moment without complex modal overlays.

## Decision

We evolve the dual-lane architecture into **Acopilot** (the foreground cognitive partner) and **Actions** (the execution and delivery feed encompassing **Developer** and **Reviewer**), orchestrated by an in-process **LaneDispatchBus** with a serialized FIFO job queue.

### 1. Role Taxonomy & Lane Structure

- **Lane 1: Acopilot (The Thinking Plane)**:
  - Serves as the primary conversational home for user collaboration, technical investigation, root cause diagnosis, architectural drafting, and GitHub Issue creation.
  - Retains full conversational capability with interactive input composer.
  - Possesses the authority to delegate approved tasks directly to the background Actions queue via `dispatch_action_job(issue_id)`.
  - Operates completely non-blocking: dispatch is asynchronous and fire-and-forget (< 2ms), returning immediate confirmation so the user can continue dialoguing without pause.

- **Lane 2: Actions (The Execution & Delivery Plane)**:
  - Encompasses two specialized sub-roles:
    1. **Developer**: Executes code implementation, test suites, and git commits on dedicated feature branches.
    2. **Reviewer**: Performs detached clean-room code review on the final diff and test reports.
  - **Preserves Existing MainChat UI & Composer**:
    - Retains `MainChatView` and `MainChatComposerPanel`.
    - Renders dense execution logs (command execution blocks, test outputs, step progress) rather than illegible code diff viewers.
    - Preserves continuous human-in-the-loop steering: the bottom composer allows the user to queue guidance prompts into the active turn or trigger immediate interruption (`interruptActive`) at any time.

### 2. In-Process LaneDispatchBus & FIFO Job Persistence

Rather than introducing external message queues (e.g. RabbitMQ, Redis), ADS coordinates Actions through an in-process `LaneDispatchBus` backed by SQLite WAL persistence in `state.db`:

```sql
CREATE TABLE IF NOT EXISTS action_jobs (
  id TEXT PRIMARY KEY,                       -- Format: job-{timestamp}-{issueId|local}-{hex4}
  project_id TEXT NOT NULL,
  job_kind TEXT NOT NULL DEFAULT 'github_issue' CHECK(job_kind IN ('github_issue', 'local_prompt')),
  issue_id INTEGER,
  issue_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'running', 'verifying', 'reviewing', 'waiting_merge', 'completed', 'failed', 'cancelled'
  )),
  branch TEXT,                               -- Dedicated branch: codex/issue-<id>
  developer_profile_id TEXT,
  reviewer_profile_ids_json TEXT NOT NULL DEFAULT '[]',
  current_step TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  review_verdicts_json TEXT NOT NULL DEFAULT '[]',
  pr_number INTEGER,
  pr_url TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_jobs_lookup ON action_jobs(project_id, status, created_at);
```

### 3. Two-Tier State Machine & Deterministic Pipeline Controller

To eliminate probabilistic LLM hallucinations and token waste during Git lifecycle operations, the system enforces a strict separation between **Cognitive Reasoning** and **Deterministic Pipeline Control**:

- **Cognitive Tier (LLM Sessions)**:
  - **Developer**: Focuses strictly on requirement comprehension, code implementation, test verification, and structured task summaries.
  - **Reviewer**: Operates in a detached clean-room context, auditing diffs and test results to produce a structured JSON verdict (`PASS` / `REJECT` + defect pointers).
  - *Hard Boundary*: LLM agents never execute Git merge, pull, push, branch deletion, or Issue closure commands.

- **Deterministic Controller Tier (`LaneDispatchBus` in Node.js)**:
  Once the Reviewer outputs its JSON verdict, the deterministic controller takes over the entire lifecycle:
  1. **Verdict Routing**:
     - On `REJECT`: Increments `rework_count`. If < 2, routes structured defects back to Developer; if limit reached, rolls working tree back to `dev` and marks status as `failed`.
     - On `PASS`: Deterministically invokes `gh pr create --title ... --body ... --label ...`, sets status to `waiting_merge`, and updates `pr_number` and `pr_url`.
  2. **Merge & Synchronization Pipeline**:
     Upon user approval (or automatic merge when configured), the controller executes the deterministic sequence:
     ```bash
     gh pr merge <pr_number> --squash --delete-branch=false
     gh issue close <issue_id>
     git checkout dev
     git pull --ff-only origin dev
     git branch -D codex/issue-<id>
     git push origin --delete codex/issue-<id>
     ```
     Verifying zero exit codes at every step, the controller updates status to `completed`.

### 4. Sequential Execution & Safe Branch Checkout Gate

Per project architectural constraints, **all development occurs strictly within the primary working directory** on dedicated branches checked out from latest `dev` (isolated `git worktree` directories are strictly prohibited).

To prevent branch divergence, uncommitted file collisions, and merge conflicts between queued tasks, the `LaneDispatchBus` enforces strict **FIFO sequential execution with a three-point checkout gate**:

1. **Terminal State Gate**: The active task (Task N) must reach a terminal state before Task N+1 can be dequeued:
   - `completed`: PR squash-merged, issue closed, and branches synchronized by the deterministic controller.
   - `failed`: Execution or review failed after retry limit, and working tree was cleanly reset to `dev`.
   - `cancelled`: Interrupted by user and working tree was cleanly reset to `dev`.
   - *Waiting Gate*: If Task N is in `waiting_merge`, Task N+1 strictly remains in `queued`.
2. **Working Tree Cleanliness Gate**:
   - Current branch must be verified on base branch: `git branch --show-current == dev`.
   - Tracked working tree must be 100% clean: `git status --porcelain` reports no staged or unstaged modifications.
3. **Base Branch Synchronization Gate**:
   - Local `dev` must be fast-forward synchronized with remote: `git fetch origin dev && git rev-parse HEAD == git rev-parse origin/dev`.

Only when all three gates evaluate to true does the runner proceed with:
`git checkout -b codex/issue-<next_id>` and transition Task N+1 from `queued` to `running`.

### 5. Detached Clean-Room Reviewer

To eliminate confirmation bias, code review is decoupled from the Developer's interactive trial-and-error tape:
- **Detached Session**: When implementation and automated tests pass, the pipeline initiates an independent Reviewer session.
- **Input Boundary**: The Reviewer receives strictly:
  1. The baseline task specification (Issue title, description, acceptance criteria).
  2. Relevant ADRs and system architectural constraints.
  3. The final `git diff origin/dev...HEAD`.
  4. Test suite execution results and exit codes.
  The Reviewer does *not* receive Developer intermediate trial logs.
- **Ensemble Review & Multi-Profile Support**: Supports dispatching to multiple Reviewer profiles in parallel (`Promise.all`), persisting heterogeneous reviews side-by-side.
- **Structured Verdict**: Reviewer outputs JSON with `PASS` or `REJECT` + actionable defect pointers. On reject, Developer executes bounded rework (max 2 attempts).

### 6. Settings UI: Model Catalog Sync & Mobile-First Role Binding

Role configuration is separated into two dedicated top-level tabs within the settings modal:

1. **Role Configuration Tab (`Roles`)**:
   - **Segmented Role Selector**: Top segmented control `[ Acopilot | Developer | Reviewer ]`.
   - **Compact Model & Effort Binding**: Dropdown binding each role to an enabled model, with standard reasoning effort selector (`low` | `medium` | `high`).
   - **Full-Height System Prompt Editor**: Textarea with historical version rollback.

2. **Model Catalog Tab (`Models`)**:
   - Retains 100% of upstream CPA `GET /v1/models` discovery, selective import, and global enablement toggles.

3. **Database Persistence (`role_profiles`)**:
   ```sql
   CREATE TABLE IF NOT EXISTS role_profiles (
     id TEXT PRIMARY KEY,
     role TEXT NOT NULL CHECK(role IN ('acopilot', 'developer', 'reviewer')),
     name TEXT NOT NULL,
     model_id TEXT NOT NULL,
     reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(reasoning_effort IN ('low', 'medium', 'high')),
     system_prompt TEXT NOT NULL,
     is_enabled INTEGER NOT NULL DEFAULT 1,
     is_default INTEGER NOT NULL DEFAULT 0,
     version INTEGER NOT NULL DEFAULT 1,
     updated_at INTEGER NOT NULL
   );
   ```

## Consequences

### Positive
- **Zero Human Router Overhead**: Automatic dispatch from Acopilot to Actions queue.
- **Full Steering Retained**: Actions retains the proven `MainChatView` and bottom composer; user can steer or interrupt at any moment.
- **Conflict-Free Branching**: Strict FIFO queueing with three-point checkout gating ensures every task builds on a clean, merged, and up-to-date `dev` base.
- **Clean Architecture & Taxonomy**: Clear separation of Acopilot (planning), Developer (coding), and Reviewer (adversarial verification) without redundant UI rewrites.
- **Mobile-Friendly**: Eliminates unreadable code diff views on mobile; maximizes readability of execution logs.

### Trade-offs & Mitigations
- **Serialized Execution**: Tasks in the Actions queue run sequentially rather than in parallel. *Mitigation*: Serialization is a deliberate architectural choice to guarantee zero merge conflicts and avoid multi-worktree toolchain/lock issues in local environments.
- **Active Preference Migration**: Client preferences are migrated in-place on startup, updating stored keys from `advisor` / `worker` to `acopilot` / `actions`.
- **Single-Workspace Intent Disambiguation**: To prevent collision between steering instructions and new tasks in Actions, in-flight composer input is strictly routed as steering context for the active Developer turn; new tasks must be dispatched from Acopilot or via explicit `/enqueue` commands.
- **Local/Offline Git Fallback**: When operating in a local-only repository (no GitHub remote) or without `gh` authentication, the deterministic controller automatically falls back to local fast-forward merge to `dev` rather than failing on `gh pr`.
- **Branch Protection Fallback**: If `gh pr merge` is blocked by remote branch protection rules (e.g. required CI checks), the controller gracefully transitions to `waiting_merge_external` and notifies the user instead of crashing.
- **Giant Diff Defense & Human Override**: Diff payload sent to Reviewer is pre-filtered (excluding lockfiles/binaries). If Reviewer rework reaches the 2-attempt limit, the system surfaces a `review_rejected` state with an explicit `[Force Override PR]` human escape hatch.

### 7. Implementation Strategy & Phased Task Decomposition

Due to the extensive blast radius across database schemas, state persistence, and frontend views, development is explicitly authorized to execute within an **isolated Git worktree** (`.worktrees/issue-277`) to keep the primary working directory clean during multi-turn delivery. Implementation is decomposed into four decoupled, verifiable phases:

- **Phase 1: Persistence & Schema Migrations (Data Layer)**
  - Add SQLite migrations for `action_jobs`, `role_profiles`, and `role_settings_history`.
  - Seed initial role profiles with system prompts and reasoning efforts.
  - Bump `PROJECT_PREFERENCES_VERSION` to 2 and implement eager localStorage migration.
  - *Deliverable*: Independent PR, zero UI breakage, verified with backend schema test suite.

- **Phase 2: Settings UI - Roles & Catalog Separation (Frontend)**
  - Restructure `ModelManager.vue` into two top tabs: Roles and Models.
  - Implement mobile-first segmented switch `[ Acopilot | Developer | Reviewer ]` with full-height prompt editor and version rollback.
  - Retain 100% upstream CPA model sync functionality.
  - *Deliverable*: Independent PR, verified with Vitest web suite.

- **Phase 3: Detached Clean-Room Reviewer Subsystem (Backend)**
  - Implement clean-room invocation runner with isolated payload (Issue + ADRs + diff + test reports).
  - Implement structured JSON verdict validator (`PASS` / `REJECT` + defects) and bounded rework loop.
  - *Deliverable*: Independent PR, verified with mocked provider tests.

- **Phase 4: In-Process Queue, Deterministic Controller & Actions UI (Integration)**
  - Implement `LaneDispatchBus` FIFO queue and Three-Point Checkout Gate.
  - Implement deterministic post-review merge and branch cleanup pipeline.
  - Wire Acopilot dispatch action and rename UI tabs to Acopilot & Actions while retaining `MainChatView` and `MainChatComposerPanel`.
  - *Deliverable*: Final PR closing Issue #277.
