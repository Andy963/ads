#!/usr/bin/env node
/**
 * Install Codex slash-command prompts that drive the ADS MCP server tools.
 *
 * The prompts mirror the behaviour of the Python ADS CLI installer, but instruct Codex
 * to call MCP tools directly instead of shelling out to `ads.*` binaries.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_DIR = path.resolve(
  process.env.CODEX_PROMPTS_DIR ?? path.join(os.homedir(), ".codex", "prompts"),
);

try {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
} catch (error) {
  console.error(`❌ Failed to create ${TARGET_DIR}: ${(error ?? {}).message ?? error}`);
  console.error("Set CODEX_PROMPTS_DIR to a writable location and re-run the installer.");
  process.exit(1);
}

function writePrompt(name, body) {
  const filePath = path.join(TARGET_DIR, `${name}.md`);
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    }
    fs.writeFileSync(filePath, body.trimEnd() + "\n", "utf8");
    console.log(`  • ${filePath}`);
  } catch (error) {
    console.error(`❌ Failed to write ${filePath}: ${(error ?? {}).message ?? error}`);
    console.error("Retry after adjusting permissions or by setting CODEX_PROMPTS_DIR.");
    process.exit(1);
  }
}

const prompts = {
  "ads.status": `
You handle the \`/ads.status\` slash command.
- Always pass the current working directory as workspace_path to the MCP tool.
- Call the MCP tool \`ads.status\` with workspace_path set to the current working directory.
- Return the tool result verbatim as Markdown. Never run shell commands.
`,
  "ads.new": `---
description: Create a new ADS workflow from a template
argument-hint: <template_id> <title> [DESCRIPTION="..."]
---

Create a new ADS workflow using the MCP tool \`ads.new\`.

Template ID: $1
Title: $2
Description: $DESCRIPTION

IMPORTANT: Always pass the current working directory as workspace_path.

Call the MCP tool \`ads.new\` with:
- template_id: $1
- title: $2
- description: $DESCRIPTION (if provided)
- workspace_path: <current working directory>

Show the tool response exactly as returned.
`,
  "ads.init": `---
description: Initialize a new ADS workspace
argument-hint: <name>
---

Initialize a new ADS workspace using the MCP tool \`ads.init\`.

Workspace name: $1

IMPORTANT: Always pass the current working directory as workspace_path.

Call the MCP tool \`ads.init\` with:
- name: $1
- workspace_path: <current working directory>

Return the tool output verbatim.
`,
  "ads.branch": `
You handle the \`/ads.branch\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Supported forms:
  * \`/ads.branch\` → call \`ads.branch\` with no arguments (list workflows).
  * \`/ads.branch delete <workflow>\` or flag form \`--operation=delete --workflow=<workflow>\`.
- IMPORTANT: Always pass the current working directory as workspace_path.
- Parse the arguments accordingly and call the MCP tool \`ads.branch\` with workspace_path set to current working directory.
- Return the tool response verbatim.
`,
  "ads.checkout": `---
description: Switch to a different ADS workflow
argument-hint: <workflow>
---

Switch to the specified ADS workflow using the MCP tool \`ads.checkout\`.

Workflow: $1

IMPORTANT: Always pass the current working directory as workspace_path.

Call the MCP tool \`ads.checkout\` with:
- workflow: $1
- workspace_path: <current working directory>

Surface the response verbatim.
`,
  "ads.add": `
You handle the \`/ads.add\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Accept either:
  * \`/ads.add STEP_NAME <markdown content>\`
  * Flag form such as \`--step_name=STEP --content="..."\`
- If the user omits content, ask for the draft content before calling the MCP tool.
- IMPORTANT: Always pass the current working directory as workspace_path.
- Once you have \`step_name\` and \`content\`, call \`ads.add\` with workspace_path set to current working directory. Present the returned text verbatim.
`,
  "ads.commit": `
You handle the \`/ads.commit\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Interpret the step name as the first positional token or \`--step_name=\`.
- Capture optional change description (rest of the positional string, or \`--change_description=\`).
- IMPORTANT: Always pass the current working directory as workspace_path.
- Call the MCP tool \`ads.commit\` with the gathered fields and workspace_path set to current working directory. Show its response exactly.
`,
  "ads.log": `
You handle the \`/ads.log\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Parse optional \`--limit=\` flag (fall back to positional order for the limit if needed).
- IMPORTANT: Always pass the current working directory as workspace_path.
- Call the MCP tool \`ads.log\` with those parameters and workspace_path set to current working directory. Return the output verbatim.
`,
  "ads.get": `
You handle the \`/ads.get\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Interpret the first positional token (or \`--step_name=\`) as the step name.
- IMPORTANT: Always pass the current working directory as workspace_path.
- Call the MCP tool \`ads.get\` with workspace_path set to current working directory and surface its response exactly.
`,
  "ads.commands": `
You handle the \`/ads.commands\` slash command.
- IMPORTANT: Always pass the current working directory as workspace_path.
- Call the MCP tool \`ads.commands\` with workspace_path set to current working directory to list available project-level commands and return the result verbatim.
`,
  "ads.run": `
You handle the \`/ads.run\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Expect the form \`/ads.run COMMAND_NAME {"var": "value"}\` (JSON may be omitted).
- IMPORTANT: Always pass the current working directory as workspace_path.
- Call the MCP tool \`ads.run\` with \`command_name\`, optional \`variables\` JSON string, and workspace_path set to current working directory. Display the tool output verbatim.
`,
};

console.log(`Installing Codex prompts under ${TARGET_DIR}`);
Object.entries(prompts).forEach(([name, content]) => writePrompt(name, content));
console.log("✅ Codex prompts installed.");
