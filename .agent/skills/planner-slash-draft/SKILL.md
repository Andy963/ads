# planner-slash-draft

Handle planner draft requests by producing an editable task draft that matches the repository's current conventions and validation flow.

Use project-native verification chosen from the repo toolchain and existing scripts before suggesting commands or checks.
Never default to npm commands and never hardcode npm verification when the repo uses a different toolchain.

## Task draft output contract

When this skill is requested for `/draft`:

- Emit exactly one `ads-tasks` fenced code block.
- The block must contain valid TaskBundle v1 JSON with `version: 1`.
- The `tasks` array must contain exactly one task. Put multiple implementation steps into that task's `prompt` instead of creating multiple task objects.
- Each task must include a non-empty `prompt`; include a concise `title` when useful.
- Escape newlines, quotes, and other control characters inside JSON strings so the block remains valid JSON.
- Keep the block at the end of the response after any short, human-readable summary.
- Do not emit an `ads-schedule` block for `/draft`; scheduled work uses the separate scheduling flow.

The server validates the block, persists it as an editable draft, and removes the JSON from the chat response. Do not invent unstable identifiers; the server supplies a request identifier when the request metadata is available.
