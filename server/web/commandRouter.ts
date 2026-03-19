import path from "node:path";

import { parseSlashCommand } from "../codexConfig.js";
import { initWorkspace, getCurrentWorkspace, syncWorkspaceTemplates } from "../workspace/service.js";
import { detectWorkspace } from "../workspace/detector.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { listRules, readRules } from "../workspace/rulesService.js";
import { normalizeOutput } from "../utils/text.js";
import { initSkill, normalizeSkillName, parseResourceList, validateSkillDirectory } from "../skills/creator.js";
import { discoverSkills, loadSkillBody, renderSkillList } from "../skills/loader.js";

export interface CommandResult {
  ok: boolean;
  output: string;
}

type CommandParams = Record<string, string>;

interface CommandContext {
  rawArgs: string[];
  positional: string[];
  params: CommandParams;
}

type CommandHandler = (context: CommandContext) => Promise<CommandResult>;

function formatResponse(text: string): string {
  if (!text.trim()) {
    return "(无输出)";
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return text;
    }
    if ((parsed as Record<string, unknown>).error) {
      return `❌ ${(parsed as Record<string, string>).error}`;
    }
    if ((parsed as Record<string, unknown>).message) {
      return String((parsed as Record<string, unknown>).message);
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

function buildAdsHelpMessage(): string {
  return "User-facing slash commands are disabled. Use the Web UI and skills to drive specs, drafts, and tasks.";
}

const commandRegistry = new Map<string, CommandHandler>([
  [
    "ads.help",
    async () => {
      return { ok: true, output: buildAdsHelpMessage() };
    },
  ],
  [
    "ads.init",
    async ({ params, positional }) => {
      const name = params.name ?? (positional.length > 0 ? positional.join(" ") : undefined);
      const response = await initWorkspace({ name });
      syncWorkspaceTemplates();
      return { ok: true, output: formatResponse(response) };
    },
  ],
  [
    "ads.rules",
    async ({ params, positional }) => {
      if (params.category || positional.length > 0) {
        const category = params.category ?? positional.join(" ");
        const response = await listRules({ category });
        return { ok: true, output: formatResponse(response) };
      }
      const response = await readRules();
      return { ok: true, output: normalizeOutput(response) };
    },
  ],
  [
    "ads.workspace",
    async () => {
      const response = await getCurrentWorkspace();
      return { ok: true, output: formatResponse(response) };
    },
  ],
  [
    "ads.skill.init",
    async ({ params, positional }) => {
      const name = (params.name ?? positional.join(" ")).trim();
      if (!name) {
        return {
          ok: false,
          output: "❌ Missing skill name",
        };
      }

      const workspaceRoot = resolveAdsStateDir();
      const includeExamples =
        params.examples === "true" || params.examples === "1" || params.examples === "yes" || params.examples === "on";
      const resources = parseResourceList(params.resources);
      try {
        const created = initSkill({ workspaceRoot, rawName: name, resources, includeExamples });
        const relDir = path.relative(workspaceRoot, created.skillDir) || created.skillDir;
        const relFiles = created.createdFiles.map((p) => path.relative(workspaceRoot, p) || p);
        const output = [
          `✅ Skill 已创建: ${created.skillName}`,
          `目录: ${relDir}`,
          relFiles.length ? `文件:\n${relFiles.map((p) => `- ${p}`).join("\n")}` : "",
          "",
          "提示：编辑 SKILL.md 完成 TODO，然后在对话中使用该 skill。",
        ]
          .filter(Boolean)
          .join("\n");
        return { ok: true, output };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: `❌ 创建 skill 失败: ${message}` };
      }
    },
  ],
  [
    "ads.skill.list",
    async () => {
      const workspaceRoot = detectWorkspace();
      const skills = discoverSkills(workspaceRoot);
      return { ok: true, output: renderSkillList(skills) };
    },
  ],
  [
    "ads.skill.load",
    async ({ params, positional }) => {
      const name = (params.name ?? positional.join(" ")).trim();
      if (!name) {
        return { ok: false, output: "❌ Missing skill name. Usage: /ads.skill.load <name>" };
      }
      const workspaceRoot = detectWorkspace();
      const body = loadSkillBody(name, workspaceRoot);
      if (!body) {
        const skills = discoverSkills(workspaceRoot);
        const available =
          skills.length > 0 ? `可用 skill: ${skills.map((s) => s.name).join(", ")}` : "当前没有可用的 skill";
        return { ok: false, output: `❌ Skill "${name}" 未找到。${available}` };
      }
      return { ok: true, output: body.trim() };
    },
  ],
  [
    "ads.skill.validate",
    async ({ params, positional }) => {
      const workspaceRoot = resolveAdsStateDir();
      const arg = (params.path ?? positional.join(" ")).trim();
      if (!arg) {
        return { ok: false, output: "❌ Missing skill name/path" };
      }

      const looksLikePath = arg.includes("/") || arg.includes("\\") || arg.startsWith(".") || arg.startsWith("~");
      const skillDir = looksLikePath ? arg : path.join(workspaceRoot, ".agent", "skills", normalizeSkillName(arg));
      const result = validateSkillDirectory(skillDir);
      const relDir = path.relative(workspaceRoot, result.skillDir) || result.skillDir;
      const output = `${result.valid ? "✅" : "❌"} ${result.message}\n目录: ${relDir}`;
      return { ok: result.valid, output };
    },
  ],
]);

export async function runAdsCommandLine(input: string): Promise<CommandResult> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: true, output: "" };
  }

  const slash = parseSlashCommand(trimmed);
  if (!slash || !slash.command.startsWith("ads.")) {
    return { ok: false, output: "❓ Unsupported command" };
  }

  // basic args parsing (similar to CLI)
  const parts = trimmed.split(/\s+/);
  const rawArgs = parts.slice(1);
  const positional: string[] = [];
  const params: Record<string, string> = {};
  for (const token of rawArgs) {
    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      if (eqIndex > -1) {
        const key = token.slice(2, eqIndex);
        const value = token.slice(eqIndex + 1);
        params[key] = value;
      } else {
        params[token.slice(2)] = "true";
      }
      continue;
    }
    positional.push(token.replace(/^['"]|['"]$/g, ""));
  }

  const handler = commandRegistry.get(slash.command);
  if (!handler) {
    return { ok: false, output: `❓ Unknown command: ${slash.command}` };
  }
  return handler({ rawArgs, positional, params });
}
