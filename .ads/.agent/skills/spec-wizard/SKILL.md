# spec-wizard

Create or update the full spec bundle directly under `docs/spec/<timestamp>-<slug>/` as a spec directory containing requirement, design, and implementation artifacts.

Use repository context to define scope, dependencies, rollout order, and verification. Always record the resulting spec bundle in `docs/spec/` and keep the artifact shape consistent with the current spec bundle / spec directory layout.

Choose project-native verification based on the repo toolchain, scripts, and existing CI conventions.
Never default to npm commands and never hardcode npm verification when the repo uses a different toolchain.
