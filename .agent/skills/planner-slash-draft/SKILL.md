# planner-slash-draft

Handle planner draft requests by producing a draft spec/task package that matches the repository's current conventions and validation flow.

Use project-native verification chosen from the repo toolchain and existing scripts before suggesting commands or checks.
Never default to npm commands and never hardcode npm verification when the repo uses a different toolchain.
