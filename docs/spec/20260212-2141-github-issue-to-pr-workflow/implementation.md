# GitHub Issue-to-PR Workflow - Implementation

## Steps
1. Add a GitHub repo resolver that parses `remote.origin.url` into `owner/name` (support SSH/HTTPS).
2. Implement a `gh` wrapper with typed functions:
   - `listIssues`, `searchIssues`, `getIssue`, `createPr` (write), etc.
3. Implement a two-phase workflow state:
   - `plan` returns `planId` + `confirmationToken` (short-lived)
   - `apply` requires matching token and re-validates constraints
4. Wire the workflow into the ADS command surface (explicit invocation only; no auto-trigger).
5. Add command-runner gates:
   - Block all writes by default
   - Allow gated writes only when explicit request + valid token
   - Handle `git push` according to chosen option (manual command output vs gated allow)
6. Add tests for:
   - repo URL parsing
   - token gating behavior
   - refusal paths when not explicitly confirmed
7. (Optional) Add background read-only “issue scout” that produces suggestions but never applies changes.

## Files Touched
- `src/workspace/rulesService.ts` — reuse/extend explicit-request enforcement for `git_commit`/`git_push`/`gh_*` actions.
- `src/utils/commandRunner.ts` and/or `src/bootstrap/commandRunner.ts` — adjust push hard-block to support gated mode (or keep blocked and provide manual commands).
- `src/.../github/*` — new integration module (exact location TBD).
- `docs/spec/...` — spec only.

## Tests
- Add unit tests for repo parsing and gating logic.
- Add integration-ish tests around command refusal vs explicit confirmation flows.

## Verification
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`

## Assumptions
- Entry is explicit invocation (`1.B`), not automatic from natural language.
- Default repo comes from `git remote origin` (`2.默认`).
- Write operations are allowed only with explicit confirmation (`4.允许` + `5.B` two-phase).
- Auth uses local `gh` login (`6.默认`), no token storage.
