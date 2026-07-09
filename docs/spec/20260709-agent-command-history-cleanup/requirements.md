# Requirements

## Title

Agent Command History Cleanup

## Background

ADS Web currently records terminal command output emitted by Codex and Claude as replayable `execute` history entries. Reconnecting or restoring a chat can therefore render every internal agent command as a visible chat message, even though those commands are implementation traces rather than user conversation.

## Goal

Keep chat history focused on user inputs and final model outputs. Internal agent command execution may be visible while a turn is running, but it must not pollute restored or completed chat history as one message per command.

## Functional Requirements

- FR-1: Completed chat history MUST restore user messages and final assistant messages.
- FR-2: Internal agent command executions from Codex and Claude MUST NOT be persisted as replayable `execute` chat history.
- FR-3: Live command previews MAY remain visible during the active turn to show progress.
- FR-4: User-explicit command execution results MUST remain replayable as `execute` history.
- FR-5: Context injection MUST NOT require restored UI chat history to display internal agent command output.
- FR-6: Regression tests MUST cover live preview behavior and completed-turn cleanup.

## Non-Goals

- Do not remove session logs or backend debug logging.
- Do not change explicit user command execution behavior.
- Do not redesign the Live Activity UI.
- Do not change database schema.

## Verification

- `npx vitest run client/src/__tests__/command-ui-lifecycle.test.ts client/src/__tests__/ws-workspace-project-sync.test.ts`
- `node --import tsx --test tests/web/workerPromptHandler.test.ts tests/web/bootstrapDelivery.test.ts tests/web/contextResume.test.ts`
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`
