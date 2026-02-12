import path from "node:path";

import { parseSlashCommand } from "../codexConfig.js";
import { createWorkflowFromTemplate } from "../workflow/templateService.js";
import {
  listWorkflows,
  checkoutWorkflow,
  getWorkflowStatusSummary,
  commitStep,
  listWorkflowLog,
} from "../workflow/service.js";
import { buildAdsHelpMessage } from "../workflow/commands.js";
import { initWorkspace, getCurrentWorkspace, syncWorkspaceTemplates } from "../workspace/service.js";
import { detectWorkspace } from "../workspace/detector.js";
import { listRules, readRules } from "../workspace/rulesService.js";
import { syncAllNodesToFiles } from "../graph/service.js";
import { normalizeOutput } from "../utils/text.js";
import { initSkill, normalizeSkillName, parseResourceList, validateSkillDirectory } from "../skills/creator.js";

export interface CommandResult {
  ok: boolean;
  output: string;
}

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



  switch (slash.command) {
    case "ads.help":
      return { ok: true, output: buildAdsHelpMessage("cli") };

    case "ads.init": {
      const name = params.name ?? (positional.length > 0 ? positional.join(" ") : undefined);
      const response = await initWorkspace({ name });
      syncWorkspaceTemplates();
      return { ok: true, output: formatResponse(response) };
    }

    case "ads.branch": {
      let deleteMode: "none" | "soft" | "hard" = "none";
      let workflowArg: string | undefined;

      for (let i = 0; i < rawArgs.length; i += 1) {
        const token = rawArgs[i];
        if (token === "-d" || token === "--delete-context") {
          deleteMode = "soft";
          workflowArg = rawArgs.slice(i + 1).join(" ") || workflowArg;
          break;
        }
        if (token === "-D" || token === "--delete" || token === "--force-delete") {
          deleteMode = "hard";
          workflowArg = rawArgs.slice(i + 1).join(" ") || workflowArg;
          break;
        }
      }

      const operation = deleteMode === "hard" ? "force_delete" : deleteMode === "soft" ? "delete" : "list";
      const workflow = deleteMode === "none" ? undefined : workflowArg?.trim().replace(/^['"]|['"]$/g, "");
      const response = await listWorkflows({ operation, workflow });
      return { ok: true, output: formatResponse(response) };
    }

    case "ads.checkout": {
      const identifier = params.workflow_identifier ?? positional[0];
      if (!identifier) {
        return { ok: false, output: "❌ 需要提供工作流标识" };
      }
      const response = await checkoutWorkflow({ workflow_identifier: identifier, format: "cli" });
      return { ok: true, output: formatResponse(response) };
    }

    case "ads.status": {
      const response = await getWorkflowStatusSummary({ format: "cli" });
      return { ok: true, output: normalizeOutput(response) };
    }

    case "ads.log": {
      let limit: number | undefined;
      let workflowFilter: string | undefined;
      if (params.limit) {
        const parsed = Number(params.limit);
        if (Number.isFinite(parsed)) {
          limit = parsed;
        }
      }
      if (params.workflow) {
        workflowFilter = params.workflow;
      }
      if (positional.length > 0) {
        const candidate = Number(positional[0]);
        if (Number.isFinite(candidate)) {
          limit = candidate;
          positional.shift();
        }
      }
      if (!workflowFilter && positional.length > 0) {
        workflowFilter = positional.join(" ");
      }
      const response = await listWorkflowLog({
        limit: typeof limit === "number" && Number.isFinite(limit) ? limit : undefined,
        workflow: workflowFilter,
        format: "cli",
      });
      return { ok: true, output: normalizeOutput(response) };
    }

    case "ads.new": {
      const titleArg = (params.title ?? positional.join(" ")).trim();
      const templateArg = params.template_id?.trim();
      if (!titleArg) {
        return { ok: false, output: "❌ Missing title" };
      }
      const response = await createWorkflowFromTemplate({
        template_id: templateArg,
        title: titleArg,
        description: params.description,
        format: "cli",
      });
      return { ok: true, output: formatResponse(response) };
    }

    case "ads.commit": {
      if (!params.step_name && positional.length > 0) {
        params.step_name = positional.shift()!;
      }
      if (!params.step_name) {
        return { ok: false, output: "❌ Missing step name" };
      }
      const response = await commitStep({ step_name: params.step_name, change_description: params.change_description, format: "cli" });
      return { ok: true, output: normalizeOutput(response) };
    }

    case "ads.rules": {
      if (params.category || positional.length > 0) {
        const category = params.category ?? positional.join(" ");
        const response = await listRules({ category });
        return { ok: true, output: formatResponse(response) };
      }
      const response = await readRules();
      return { ok: true, output: normalizeOutput(response) };
    }

    case "ads.workspace": {
      const response = await getCurrentWorkspace();
      return { ok: true, output: formatResponse(response) };
    }

    case "ads.sync": {
      const response = await syncAllNodesToFiles({});
      return { ok: true, output: formatResponse(response) };
    }

    case "ads.skill.init": {
      const name = (params.name ?? positional.join(" ")).trim();
      if (!name) {
        return {
          ok: false,
          output: "❌ Missing skill name",
        };
      }

      const workspaceRoot = detectWorkspace();
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
    }

    case "ads.skill.validate": {
      const workspaceRoot = detectWorkspace();
      const arg = (params.path ?? positional.join(" ")).trim();
      if (!arg) {
        return { ok: false, output: "❌ Missing skill name/path" };
      }

      const looksLikePath = arg.includes("/") || arg.includes("\\") || arg.startsWith(".") || arg.startsWith("~");
      const skillDir = looksLikePath
        ? arg
        : path.join(workspaceRoot, ".agent", "skills", normalizeSkillName(arg));
      const result = validateSkillDirectory(skillDir);
      const relDir = path.relative(workspaceRoot, result.skillDir) || result.skillDir;
      const output = `${result.valid ? "✅" : "❌"} ${result.message}\n目录: ${relDir}`;
      return { ok: result.valid, output };
    }



    default:
      return { ok: false, output: `❓ Unknown command: ${slash.command}` };
  }
}
