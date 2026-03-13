# Design: Workspace Detector Root Normalization

## Summary

Normalize all explicit workspace inputs in `server/workspace/detector.ts` through one shared helper so every public API agrees on the workspace root before creating state paths, specs, or templates.

SSOT: goals and acceptance criteria live in `requirements.md`.

## Before

- `resolveWorkspaceRoot()` exists, but only some higher-level services call it.
- Several detector helpers still do `resolveAbsolute(workspace)` directly.
- Callers that pass a subdirectory can accidentally split state across:
  - centralized ADS state for `/repo/nested`
  - specs under `/repo/nested/docs/spec`
  - other services already normalized to `/repo`

## After

- Detector helpers that accept an explicit workspace path use a single root-resolution helper.
- Nested paths inside a git workspace resolve to the git root before:
  - legacy migration
  - state path derivation
  - spec directory creation
  - template bootstrap
  - workspace info reporting
- No behavior changes for omitted workspace inputs or already-normalized roots.

## Key Decisions

- Decision: add a small internal helper instead of rewriting each function independently.
  - Why:
    - keeps root resolution semantics centralized
    - reduces future drift if more detector helpers are added
    - makes the patch easy to review and roll back
- Decision: keep `initializeWorkspace()` special-cased for the no-argument path.
  - Why:
    - current behavior initializes `process.cwd()` when no workspace is provided
    - switching that path to `detectWorkspace()` could silently change behavior under `AD_WORKSPACE` or async context
    - only explicit workspace arguments need the new root normalization

## Risks & Mitigations

- Risk: some caller may have been relying on the old incorrect nested-path behavior.
  - Mitigation: scope the change to explicit nested paths inside detected workspaces and add regression tests describing the intended contract.
- Risk: tests could still pass while duplicated directories are created elsewhere.
  - Mitigation: assert both positive behavior at the root and negative behavior in nested child locations.

## Rollback

- Revert `server/workspace/detector.ts`.
- Revert `tests/workspace/detector.test.ts`.
- Remove the spec directory if needed.
