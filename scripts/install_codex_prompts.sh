#!/usr/bin/env bash
set -euo pipefail

# Install ADS slash-command prompts for Codex CLI.
#
# This script creates ~/.codex/prompts (if missing) and writes concise prompt
# files that map /ads.* commands to the new CLI entry points (ads.new, ads.add,
# etc.).  Existing prompt files are preserved with a .bak suffix.

TARGET_DIR="${HOME}/.codex/prompts"
mkdir -p "${TARGET_DIR}"

write_prompt() {
  local name="$1"
  local body="$2"
  local path="${TARGET_DIR}/${name}.md"

  if [[ -f "${path}" ]]; then
    if ! cp "${path}" "${path}.bak"; then
      echo "❌ Failed to back up existing ${path}" >&2
      exit 1
    fi
  fi

  if ! printf "%s\n" "${body}" > "${path}"; then
    echo "❌ Failed to write prompt to ${path}" >&2
    exit 1
  fi

  echo "  • ${path}"
}

write_prompt "ads.status" \
"Run \`ads.status \$ARGUMENTS\` in the current workspace and return the CLI stdout as Markdown. If it fails, show the error text."

write_prompt "ads.new" \
"Take everything after \`/ads.new\` as CLI arguments, run \`ads.new \$ARGUMENTS\`, and paste the stdout verbatim. Use the current workspace."

write_prompt "ads.add" \
"If the user provides inline content with \`/ads.add STEP ...\`, write that content to a temp file and run \`ads.add STEP --file <tmp-file>\`. If they only specify the step, ask for the content first. Surface the CLI stdout verbatim."

write_prompt "ads.commit" \
"Run \`ads.commit \$ARGUMENTS\` (e.g. \`ads.commit requirement -m \"确认\"\`). Return stdout unchanged so the user sees the workflow update."

write_prompt "ads.checkout" \
"Execute \`ads.checkout \$ARGUMENTS\` in the workspace and show the command output verbatim."

write_prompt "ads.branch" \
"Dispatch \`ads.branch \$ARGUMENTS\` (list or delete workflows) and return the CLI stdout as-is."

write_prompt "ads.log" \
"Run \`ads.log \$ARGUMENTS\` to show recent workflows and return the CLI output verbatim."

write_prompt "ads.get" \
"Execute \`ads.get \$ARGUMENTS\` to display workflow node details. Pass through stdout exactly."

write_prompt "ads.commands" \
"Run \`ads.commands \$ARGUMENTS\` so the user can inspect available custom commands."

write_prompt "ads.run" \
"Pass the user arguments to \`ads.run \$ARGUMENTS\`, preserving any JSON payloads exactly, and return stdout verbatim."

echo "✅ Codex prompts installed under ${TARGET_DIR}"
