# ADR 0001: Retire Claude CLI Adapter and Obsolete Reviewer Model Settings in Favor of Unified Codex Engine

## Status
Accepted

## Context
ADS previously maintained two divergent agent execution runtimes:
1. **Codex App-Server Adapter**: A stateful JSON-RPC daemon supporting native multi-provider routing (OpenAI, Anthropic Claude via proxy/custom models, Google Gemini, DeepSeek, and local models), structured tool calls, sandbox enforcement, and session resumption (`thread/resume`).
2. **Claude CLI Adapter**: A child-process wrapper around the third-party Claude CLI, requiring stdout JSONL heuristic reconstruction (`ClaudeStreamParser`) and complex dual-agent thread tracking (`SessionManager.maybeMigrateThreadState`, `resumeThreadIds`).

Additionally, the TaskQueue review/rework state machine was decommissioned in Issue #132 in favor of GitHub-native workflows and worker self-review, leaving the dedicated "Reviewer Model" UI panel and backend store (`reviewer_model_settings`) obsolete.

Maintaining this bifurcated architecture caused ongoing friction:
- Duplicated lifecycle abstractions and test suites across two distinct adapter paradigms.
- Fragile JSONL heuristic stream parsing that broke on Claude CLI upstream formatting adjustments.
- Confusing dual-CLI selection tabs in `ModelManager.vue` despite Codex natively supporting arbitrary provider models through `custom_models.json` / `config.toml`.

## Decision
1. **Unify on Codex App-Server as Single Provider Runtime**:
   - Decommission `ClaudeCliAdapter`, `ClaudeStreamParser`, `claudeSessionSource`, and Claude parser utilities.
   - All models (including Claude models, Gemini, DeepSeek, OpenAI) route uniformly through Codex App-Server.
2. **Simplify Session Continuity**:
   - Normalize `SessionManager` to manage a 1:1 relationship between user sessions and stable Codex thread IDs.
   - Remove dual-agent thread branching, `maybeMigrateThreadState`, and `resumeThreadIds`.
   - Update `agentSelection.ts` to default uniformly to `codex`.
3. **Retire Reviewer Model Picker & API**:
   - Remove `/api/reviewer-model` endpoints (`GET` and `PATCH`).
   - Retain the SQLite `reviewer_model_settings` table dormant to prevent unauthorized data destruction.
   - Remove the `reviewerModelPanel` section from `ModelManager.vue`.
4. **Flatten Model Management UI**:
   - Refactor `ModelManager.vue` into a clean, flat list of enabled concrete models without dual CLI accordion grouping.

## Consequences
### Positive
- Greatly reduced code footprint and cognitive overhead across server, client, and testing surfaces.
- Single unified session lifecycle with predictable `thread/resume` semantics.
- Streamlined model administration UI presenting a cohesive model list.
- Eliminated heuristic CLI JSONL line parsing and brittle regex matching.

### Trade-offs & Migration
- Direct CLI-level invocation of Claude CLI without Codex App-Server is no longer supported. Users wanting Claude models configure them via Codex multi-provider settings.
- Legacy `reviewer_model_settings` records remain dormant in SQLite without active readers or writers.
