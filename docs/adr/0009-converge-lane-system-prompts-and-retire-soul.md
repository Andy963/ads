# ADR 0009: Converge System Prompts on Versioned Web Lanes

Status: Proposed

## Context

ADS had several overlapping prompt sources: repository template files, planner-specific template files, workspace Soul files, and runtime preference extraction. This made prompt ownership difficult to audit and allowed prompt behavior to vary by workspace file state. Web already has two explicitly separated execution lanes, but Telegram and scheduler sessions do not participate in that separation.

## Decision

Store the Advisor and Worker system prompts in the central SQLite state database. Seed one immutable baseline version per lane, append every edit as a new version, and point the active state at the selected version. Reset changes only the active pointer back to the baseline and preserves the version history.

Inject the Advisor prompt only into the Web Planner session and the Worker prompt only into the Web Worker session. Telegram and scheduler sessions receive no lane prompt. Remove the legacy prompt template files, workspace template synchronization, Soul files, preference extraction, and their APIs.

Lane identity is an execution boundary, not a user or project dimension. There is one Advisor lane and one Worker lane for the Web runtime.

## Consequences

Prompt changes are centrally manageable, hot-loaded on the next turn, auditable through version history, and independent of workspace files. The Web UI must expose lane selection, editing, reset, and version metadata. Existing state databases receive a forward-only schema migration; old prompt and Soul files are no longer read or copied. The separate requirement to filter thought, plan, patch, and command content from memory remains outside this ADR and requires its own issue.
