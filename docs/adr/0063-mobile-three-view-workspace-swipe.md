# ADR 0063: Extend Mobile Horizontal Swipe Carousel to All Three Workspace Views

## Status

Accepted - 2026-11-24. Supersedes ADR 0056's mobile two-lane swipe restriction while preserving ADR 0056's pull-request cache, workspace layout, and desktop tab-click model.

## Context

ADR 0056 added the project `PRs` workspace view alongside `Acopilot` and `Actions`, but kept `.lanePanelsTrack` as a 2-panel (200%) mobile carousel and exited swiping whenever `PRs` was active. On mobile viewports, users had to tap the tab bar to enter or leave `PRs` despite swiping freely between `Acopilot` and `Actions`.

## Decision

- Extend `.lanePanelsTrack` on mobile viewports to a 3-panel carousel (`width: 300%`, each panel `33.333333%`) covering `acopilot` (index 0), `actions` (index 1), and `prs` (index 2).
- Keep desktop viewports unchanged: `.lanePanelsTrack` remains `display: contents` and inactive panels are hidden via inline `display: none`.
- Generalize `LaneGesture`, `settleLaneGesture`, `clampLaneOffsetWithResistance`, and `--lane-pill-progress` across `WorkspaceView` indices `[0, 2]`, with rubber-band resistance at the outer left (`acopilot`) and right (`prs`) boundaries.
- Mount `PullRequestsWorkspace` lazily inside `#lane-panel-prs` only when `activeWorkspaceView === 'prs'` or while a mobile drag crosses past `actions` toward `prs`, avoiding eager PR fetches during normal chat turns.
- Preserve vertical scroll locking (`LANE_SWIPE_RATIO`), drawer left-edge reservation, text-selection protection, and ignore touches starting inside `.prFilterScroller` so horizontal PR filter scrolling never triggers view switches.

## Consequences

- Mobile users can swipe smoothly across `Acopilot` <-> `Actions` <-> `PRs` with synchronized tab-pill animation and consistent boundary resistance.
- Desktop single-pane tab clicks and pull-request backend/cache behavior remain unchanged.
