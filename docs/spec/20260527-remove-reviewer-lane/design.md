# Design: Remove Reviewer Lane

## Overview

The reviewer lane is removed by collapsing the web runtime model to two lanes: planner and worker. Review-specific state is not migrated or deleted; it becomes legacy data that is no longer surfaced or mutated by the web workflow.

## Backend Design

The websocket lane resolver exposes only planner-specific resources and worker-default resources. A chat session id of `planner` selects planner resources. Any other chat session id uses worker resources, and the UI no longer opens reviewer connections.

The web server startup path creates only worker and planner lane resources. Task queue startup no longer receives reviewer session managers or reviewer broadcast hooks. Review pipeline modules are removed from the runtime graph.

Review queue API routes are removed from the API handler. Task routes no longer accept review fields or review artifact references.

Task storage types and mappers no longer expose review fields on `Task`. Existing schema columns can remain in SQLite for compatibility, but the active TypeScript model ignores them.

## Frontend Design

The app exposes only Planner and Worker tabs. The reviewer binding composable, reviewer panel, review queue panel, review snapshot modal, review-required task fields, and review badges are removed from active UI paths.

Task stage calculation treats completed tasks as done without a review gate. Task sorting no longer accounts for review status.

## Compatibility

Existing databases may still contain review-related columns and tables. This change avoids destructive migrations, so existing state remains readable by older versions if needed.

Existing test fixtures are updated to remove reviewer-only expectations. Tests that exist only to validate reviewer behavior are removed.

## Risks

1. Some old docs and legacy migrations still mention review concepts. That is acceptable as historical context, but active runtime imports must not depend on reviewer lane modules.
2. Hidden references in tests may keep stale reviewer assumptions alive. Typecheck and focused searches are used to catch those.
