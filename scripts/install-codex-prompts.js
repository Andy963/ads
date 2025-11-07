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
- Trim whitespace from \`$ARGUMENTS\`.
- Parse optional flags like \`--workspace_path=/path/to/workspace\`.
- Call the MCP tool \`ads.status\` with the parsed arguments (omit fields that were not provided).
- Return the tool result verbatim as Markdown. Never run shell commands.
`,
  "ads.new": `---
description: Create a new ADS workflow from a template
argument-hint: <template_id> <title> [DESCRIPTION="..."] [WORKSPACE_PATH="..."]
---

Create a new ADS workflow using the MCP tool \`ads.new\`.

Template ID: $1
Title: $2
Description: $DESCRIPTION
Workspace Path: $WORKSPACE_PATH

Call the MCP tool \`ads.new\` with:
- template_id: $1
- title: $2
- description: $DESCRIPTION (if provided)
- workspace_path: $WORKSPACE_PATH (if provided)

Show the tool response exactly as returned.
`,
  "ads.init": `---
description: Initialize a new ADS workspace
argument-hint: <name> [WORKSPACE_PATH="..."]
---

Initialize a new ADS workspace using the MCP tool \`ads.init\`.

Workspace name: $1
Workspace path: $WORKSPACE_PATH

Call the MCP tool \`ads.init\` with:
- name: $1
- workspace_path: $WORKSPACE_PATH (if provided)

Return the tool output verbatim.
`,
  "ads.branch": `
You handle the \`/ads.branch\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Supported forms:
  * \`/ads.branch\` → call \`ads.branch\` with no arguments (list workflows).
  * \`/ads.branch delete <workflow>\` or flag form \`--operation=delete --workflow=<workflow>\`.
  * \`--workspace_path=\` may be provided at any time.
- Parse the arguments accordingly and call the MCP tool \`ads.branch\`.
- Return the tool response verbatim.
`,
  "ads.checkout": `---
description: Switch to a different ADS workflow
argument-hint: <workflow> [WORKSPACE_PATH="..."]
---

Switch to the specified ADS workflow using the MCP tool \`ads.checkout\`.

Workflow: $1
Workspace path: $WORKSPACE_PATH

Call the MCP tool \`ads.checkout\` with:
- workflow: $1
- workspace_path: $WORKSPACE_PATH (if provided)

Surface the response verbatim.
`,
  "ads.add": `
You handle the \`/ads.add\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Accept either:
  * \`/ads.add STEP_NAME <markdown content>\`
  * Flag form such as \`--step_name=STEP --content="..." --workspace_path=...\`
- If the user omits content, ask for the draft content before calling the MCP tool.
- Once you have \`step_name\` and \`content\`, call \`ads.add\` with optional \`workspace_path\`. Present the returned text verbatim.
`,
  "ads.commit": `
You handle the \`/ads.commit\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Interpret the step name as the first positional token or \`--step_name=\`.
- Capture optional change description (rest of the positional string, or \`--change_description=\`) and optional \`--workspace_path=\`.
- Call the MCP tool \`ads.commit\` with the gathered fields and show its response exactly.
`,
  "ads.log": `
You handle the \`/ads.log\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Parse optional \`--limit=\` and \`--workspace_path=\` flags (fall back to positional order for the limit if needed).
- Call the MCP tool \`ads.log\` with those parameters and return the output verbatim.
`,
  "ads.get": `
You handle the \`/ads.get\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Interpret the first positional token (or \`--step_name=\`) as the step name, plus optional \`--workspace_path=\`.
- Call the MCP tool \`ads.get\` and surface its response exactly.
`,
  "ads.commands": `
You handle the \`/ads.commands\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Parse optional \`--workspace_path=\`.
- Call the MCP tool \`ads.commands\` to list available project-level commands and return the result verbatim.
`,
  "ads.run": `
You handle the \`/ads.run\` slash command.
- Trim whitespace from \`$ARGUMENTS\`.
- Expect the form \`/ads.run COMMAND_NAME {"var": "value"}\` (JSON may be omitted).
- Parse optional \`--workspace_path=\`.
- Call the MCP tool \`ads.run\` with \`command_name\`, optional \`variables\` JSON string, and any workspace override. Display the tool output verbatim.
`,
};

console.log(`Installing Codex prompts under ${TARGET_DIR}`);
Object.entries(prompts).forEach(([name, content]) => writePrompt(name, content));
console.log("✅ Codex prompts installed.");
