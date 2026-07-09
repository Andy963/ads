# Design

## Overview

Split command execution visibility into two categories:

- User command results: durable chat history, replayed as `execute` blocks.
- Agent internal commands: live progress only, not replayed as chat history.

The existing live WebSocket `command` event remains available to the frontend. The persistence path for terminal agent command output is removed so restored history is no longer filled with internal command blocks.

## Server Behavior

`attachWorkerPromptHandler` continues to send live `type: "command"` events when an agent emits command execution events. It stops writing terminal agent command output to `historyStore` as `kind: "execute"`.

The existing `kind: "command"` marker for agent commands is also not required for UI restore. If retained, bootstrap replay already ignores it; however avoiding the marker keeps the persisted conversation closer to user-visible history.

Explicit command execution through the WebSocket command path keeps using `kind: "execute"` because it represents a direct user command result.

## Client Behavior

The frontend keeps rendering live execute previews while a turn is active. On normal turn completion, transient execute previews are removed instead of finalized into durable chat messages.

History replay continues to support `kind: "execute"` for explicit user command results and existing stored entries. New agent turns no longer create those entries.

## Compatibility

Existing persisted `execute` entries may still replay until old history is cleared. This change prevents new agent internal commands from being added to replayable chat history.

## Risks

- Removing finalized live previews may reduce immediate post-turn visibility into what the agent did. The final assistant summary and session logs remain the durable record.
- Tests that previously treated agent command output as durable chat history must be updated to the new boundary.
