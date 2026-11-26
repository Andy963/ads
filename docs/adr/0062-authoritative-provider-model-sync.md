# ADR 0062: Authoritative Upstream Provider Model Sync

## Status

Accepted - 2026-11-24. Partially supersedes ADR 0035's additive-only provider sync decision while retaining ADR 0035's per-provider isolation, user-edit preservation, and transactional deletion cleanup invariants.

## Context

ADR 0035 defined provider model synchronization (`POST /api/model-providers/:provider_id/models/sync`) as additive-only so user aliases and reasoning settings were preserved. In practice, upstream providers frequently retire or rename models; additive-only sync left deprecated models stranded in `model_configs`, `model_service_members`, and `role_profiles` until deleted manually one by one.

## Decision

- Treat a successful upstream response from `POST /api/model-providers/:provider_id/models/sync` as the authoritative catalog for that provider.
- Execute provider catalog reconciliation in a single `IMMEDIATE` SQLite transaction (`ads_state::reconcile_provider_models`):
  1. Insert upstream models not yet present for that `provider_id` without auto-enabling them into services and without overwriting surviving models' custom aliases or `config_json`.
  2. Identify local models belonging strictly to `provider_id` whose `model_id` is absent from the upstream response, clean up their `model_service_members` (promoting the next service default when needed) and `role_profiles` references via `remove_model_service_references_tx`, and delete them from `model_configs`.
  3. Leave models belonging to other providers and unassociated legacy models (`provider_id IS NULL`) untouched.
- Bypass the 30-second discovery response cache during explicit provider sync so upstream additions and removals take effect immediately.
- Keep `ts-server` unchanged; this behavior is owned by `rust-server`.

## Consequences

- Retired upstream models disappear automatically on sync and never leave dangling service defaults or role-profile references.
- Surviving models retain user-edited display names and reasoning effort settings across syncs.
