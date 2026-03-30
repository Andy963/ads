# spec-to-task

Convert an approved spec bundle in `docs/spec/` into actionable implementation tasks with explicit dependencies, validation steps, and exit criteria.

Select project-native or repo-native verification for each task by reading the repository toolchain and existing scripts.
Never default to npm commands and never hardcode npm verification when the repo uses another toolchain.
