---
name: update-rules-md
description: "Update workspace .ads/rules.md via '更新rules:' or 'update rules:' (no slash), with backup and safe overwrite."
---

# Update Rules Md
## Overview
This skill updates the workspace rules file used by ADS prompts.

It supports two equivalent plain-text triggers (NOT slash commands):
- `更新rules:` or `更新rules：`
- `update rules:` or `update rules：`

Both triggers map to the same behavior: update `.ads/rules.md` in the current workspace root.

## Target
- Primary file: `.ads/rules.md`
- Fallback template: `templates/rules.md`

## Behavior
1. Determine workspace root (assume current repo root; ensure `.ads/` exists).
2. Ensure `.ads/rules.md` exists:
   - If missing, copy `templates/rules.md` to `.ads/rules.md`.
3. Create a backup before modification:
   - `.ads/rules.md.bak-<timestamp>`
4. Update strategy:
   - If the user message contains a fenced code block, overwrite `.ads/rules.md` with the code block content verbatim.
   - Else, treat the text after the first `:` or `：` as an edit instruction, read `.ads/rules.md`, produce updated content, and overwrite.
5. Report:
   - The updated path, backup path, and a short summary of what changed.

## Safety
- Never touch any `.db` files.
- Never delete `.ads/` or any workspace state files.
- If writing fails, keep the original file intact; the backup must remain.

## Verification (commands)
- `sed -n '1,40p' .ads/rules.md`
- `test -f .ads/rules.md && echo OK`
