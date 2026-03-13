# Workspace Detector Root Normalization

## Background

ADS has already been converging `workspace_path` inputs onto the workspace root in workflow and graph services. `server/workspace/detector.ts` added `resolveWorkspaceRoot()` for that purpose, but several public helpers still resolve a provided path directly and treat it as the workspace root.

That creates a split-brain risk when a caller passes a nested directory inside a git workspace:

- `detectWorkspaceFrom("/repo/nested")` returns `/repo`
- `getWorkspaceDbPath("/repo/nested")` currently uses `/repo/nested`
- `getWorkspaceSpecsDir("/repo/nested")` currently uses `/repo/nested/docs/spec`
- `ensureDefaultTemplates("/repo/nested")` currently populates state for `/repo/nested`

The result is inconsistent state, duplicate `docs/spec` directories, and harder-to-debug behavior depending on which helper a call path happens to use.

## Goals

- Make `server/workspace/detector.ts` public helpers consistently normalize explicit workspace inputs to the detected workspace root.
- Keep behavior unchanged for callers that already pass the actual workspace root or omit the parameter entirely.
- Add regression tests that lock this nested-path behavior down.
- Update the ongoing refactor tracker so future passes know this workspace-root divergence has been handled.

## Non-goals

- Do not change the centralized ADS state layout.
- Do not redesign template bootstrap or legacy migration semantics.
- Do not refactor unrelated frontend code or user-modified files in the current worktree.

## Scope

- In scope:
  - `server/workspace/detector.ts`
  - `tests/workspace/detector.test.ts`
  - `docs/REFACTOR.md`
  - `docs/spec/20260313-2142-workspace-detector-root-normalization/`
- Out of scope:
  - `server/storage/database.ts` call-site cleanup beyond verifying behavior
  - broader workspace bootstrap architecture changes

## Functional Requirements

- FR1: `getWorkspaceDbPath(workspace)` must resolve nested paths onto the detected workspace root before deriving state paths.
- FR2: `getWorkspaceRulesDir(workspace)`, `getWorkspaceSpecsDir(workspace)`, `isWorkspaceInitialized(workspace)`, `ensureDefaultTemplates(workspace)`, and `getWorkspaceInfo(workspace)` must follow the same normalization rule.
- FR3: `initializeWorkspace(workspace)` must initialize the detected workspace root when a nested path inside a git workspace is provided.
- FR4: When no explicit workspace path is provided, existing behavior must remain unchanged.
- FR5: Regression tests must prove that nested paths do not create duplicated state/spec/template locations under child directories.

## Acceptance Criteria

- [ ] Passing a nested directory inside a git workspace to `initializeWorkspace()` returns the git root and writes workspace state there.
- [ ] Passing a nested directory to `getWorkspaceDbPath()`, `getWorkspaceRulesDir()`, `getWorkspaceSpecsDir()`, and `ensureDefaultTemplates()` uses the git root rather than the child path.
- [ ] Existing detector tests continue to pass without behavior regressions for root inputs.
- [ ] Verification completes with:
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npm test`

## Verification

- Run `npx tsc --noEmit`.
- Run `npm run lint`.
- Run `npm test`.
