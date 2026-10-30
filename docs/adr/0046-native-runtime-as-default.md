# ADR 0046: Make the Native Runtime the Default Backend

## Status

Accepted — supersedes the default-backend clause of ADR 0013

## Context

ADR 0013 added the in-process Native Runtime as an opt-in backend selected with
`ADS_AGENT_RUNTIME=native`, while an unset variable still constructed
`CodexAppServerAdapter`. Every Native capability since then — Responses and Chat
Completions protocols, token-aware context projection, transcript persistence,
bounded retry and recovery, cancellation, image input, and the four built-in
tools — shipped behind that opt-in, so the well-tested path was never the path
that ran by default.

That inverted the maintenance burden. The default required an installed and
configured `codex` CLI on every host, while the runtime ADS actually controls,
instruments, and tests end to end stayed secondary. Persisted session state also
mixed both backends: records written under `codex-app-server` outlive a switch
of the process-level backend.

## Decision

- Native is the default runtime. `DEFAULT_AGENT_RUNTIME` is the single source of
  truth for every fallback default; the runtime resolver, session resume state,
  session catalog, and web resume handler all read it instead of restating
  `"codex-app-server"`.
- An unset or blank `ADS_AGENT_RUNTIME` selects Native. `native` and
  `in-process` select Native explicitly. `codex-app-server`, `codex`, and `cli`
  select the Codex app-server backend explicitly.
- An unknown `ADS_AGENT_RUNTIME` value logs a warning and falls back to
  `codex-app-server`, not Native. A typo must never silently promote a process
  into full-access host execution.
- Codex App-Server remains a first-class backend. ADR 0026's dual-runtime
  constraint for Actions is unchanged: both Developer and Reviewer must keep
  working under either backend.
- Backend selection stays process-scoped and mutually exclusive. A session
  cannot switch backend mid-lifecycle and cannot resume a provider thread across
  backends (ADR 0021, ADR 0026).
- Session continuity degrades instead of failing. When the process runs Native
  and a stored record still points at a Codex thread, ADS does not attempt to
  resume that thread; it injects the ADS history and records the current backend
  on the next write (ADR 0028). Records with no saved thread remain `fresh`, so
  a first-time conversation is not mislabelled as history injection.
- Explicit resume under Native reattaches the lane's durable transcript instead
  of resetting the session. Resetting would delete transcripts, tool evidence
  and turns beyond the recap window, while the prompt path already injects
  history when no transcript is restorable.
- Native no longer probes the `codex` CLI. Availability probing is gated by
  `requiresCliAvailabilityProbe` and only runs for `codex-app-server`, so a host
  without the CLI is not reported as unavailable.

## Consequences

The default install needs only a configured model provider. Native session
continuation, persistence, cancellation, error recovery, image input, and tool
execution are now exercised by every default run, which is where regressions
must be caught. The Codex app-server path is unchanged in behaviour but is
opt-in, so its coverage depends on explicit deployments and CI rather than on
ordinary usage.

Existing ADS-linked `codex-app-server` sessions remain available in the session
picker. Under Native, selecting one loads its linked transcript from
`HistoryStore`, copies the selected conversation into the active lane history,
and injects it into a fresh Native session; the source history remains intact.
The copy skips entries the target lane already has and drops the source prompt
id, so restoring the same source twice is idempotent under the per-session
client-message index.

Native lanes are listed too. Each successful Native turn records a
`history_session_links` row whose provider session id is the lane's durable
`nativeTranscriptId`, so the picker can list the conversation and the resume
handler can map the selection back to its `HistoryStore` entries. Selecting the
row for the lane that is already active is a reattach: it never drops the
session or clears the durable transcript, because that row names the very
transcript the lane is using.

This is a degraded continuation, not provider-thread resume. Sessions discovered
only from provider files without an ADS history link cannot use this path.
Flipping `ADS_AGENT_RUNTIME` back does not restore the old provider thread for a
session whose backend record has been rewritten.
