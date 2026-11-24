# ADR 0059: Require Complete Declarations Before Review Redispatch

## Status

Accepted - 2026-11-24.

## Context

The Rust Acopilot flow allowed a pull request to be redispatched after a `REJECT` without recording whether the implementation addressed the defect family, its root cause, and affected state transitions. Repeated local fixes could therefore reach review without a durable account of the repair or regression evidence.

## Decision

- A redispatch after a completed, non-superseded `REJECT` must include a complete declaration identifying the prior review job, Issue, PR, base, rejected head, and new head.
- Each declared review job persists `rework_root_job_id`, an immutable SQLite lineage key pointing to the original rejected review job. Queue supersession may retire predecessor rows, but it cannot change this root identity.
- An operational retry may update the declaration's new head and corresponding rework evidence only when the original REJECT job, Issue, PR, base, and rejected head remain identical; the current head is validated again before the Reviewer runs.
- The declaration records root cause, governing invariant, audited scope, changed behavior, regression cases, verification evidence, and residual risks. It is persisted with the new review job in the Rust server's SQLite `action_jobs` table.
- For a redispatched review, the declaration is included in the structured Reviewer payload as an auditable claim. The Reviewer is explicitly instructed to verify it independently against the Issue, diff, and test report.
- Dispatch validates the declaration against the latest completed, non-superseded review for the same project, branch, and PR. The Actions queue validates it again against the resolved Issue, PR, base, branch, and actual new head before running verification or the Reviewer.
- Operational outcomes such as `INCOMPLETE` and `ERROR` do not require a rework declaration. They continue through operational recovery.
- If an operational retry was dispatched with a valid declaration, that declaration remains attached to subsequent operational retries until a new authoritative verdict is produced. A changed head requires an updated declaration; operational recovery cannot erase or replace the pending root-REJECT evidence.
- This lifecycle invariant is implemented and owned by `rust-server`; TypeScript server behavior and schema remain outside this change.

## Consequences

Review redispatch now has durable, exact-target evidence of the work performed after rejection. SQLite schema version 49 adds a nullable declaration column, preserving existing rows, and schema version 50 adds immutable rejected-job lineage. Schema version 51 refreshes the persisted Acopilot review instruction on existing databases while retaining surrounding custom prompt text. A declaration cannot be reused after a newer review outcome or against a different target.
