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
import { listRules, readRules } from "../workspace/rulesService.js";
import { syncAllNodesToFiles } from "../graph/service.js";
import { runReview, skipReview, showReviewReport } from "../review/service.js";
import { WorkflowContext } from "../workspace/context.js";
import { parseBooleanParam, resolveCommitRefParam } from "../utils/commandParams.js";
import { normalizeOutput } from "../utils/text.js";
import { REVIEW_LOCK_SAFE_COMMANDS } from "../utils/reviewLock.js";

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
    return { ok: false, output: "❓ 仅支持 /ads.* 命令" };
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

  const reviewLocked = WorkflowContext.isReviewLocked();
  if (reviewLocked && !REVIEW_LOCK_SAFE_COMMANDS.has(slash.command)) {
    return { ok: false, output: "⚠️ 当前工作流正在进行 Review。请等待完成或使用 /ads.review --show 查看报告。" };
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
        return { ok: false, output: "❌ 用法: /ads.new <标题>" };
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
        return { ok: false, output: "❌ 用法: /ads.commit <step>" };
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

    case "ads.review": {
      if (!params.skip && positional[0]?.toLowerCase() === "skip") {
        params.skip = positional.slice(1).join(" ");
      }
      const wantsShow = params.show === "true" || positional[0]?.toLowerCase() === "show";
      const workflowArg = params.workflow ?? (wantsShow ? positional.slice(1).join(" ") : undefined);
      const agent =
        (params.agent as "codex" | undefined) ??
        (positional[0]?.toLowerCase() === "codex"
          ? (positional.shift()!.toLowerCase() as "codex")
          : undefined);
      const specOverride = parseBooleanParam(params.spec);
      const noSpecFlag =
        parseBooleanParam(params["no-spec"]) ??
        parseBooleanParam(params["no_spec"]) ??
        parseBooleanParam(params.nospec);
      let includeSpec = specOverride ?? false;
      let specMode: "default" | "forceInclude" | "forceExclude" =
        specOverride !== undefined ? (includeSpec ? "forceInclude" : "forceExclude") : "default";
      if (noSpecFlag !== undefined) {
        includeSpec = !noSpecFlag;
        specMode = includeSpec ? "forceInclude" : "forceExclude";
      }
      const commitFlagRef = resolveCommitRefParam(params.commit);
      let commitRef = commitFlagRef;
      if (!commitRef && positional[0]?.toLowerCase() === "commit") {
        commitRef = positional[1] && !positional[1].startsWith("--") ? positional[1] : undefined;
        commitRef = commitRef?.trim() || "HEAD";
      }
      if (commitRef) {
        commitRef = commitRef.trim() || "HEAD";
      }
      if (wantsShow) {
        const response = await showReviewReport({ workflowId: workflowArg });
        return { ok: true, output: response };
      }
      if (params.skip) {
        const response = await skipReview({ reason: params.skip, requestedBy: "web" });
        return { ok: true, output: response };
      }
      const response = await runReview({ requestedBy: "web", agent, includeSpec, commitRef, specMode });
      return { ok: true, output: response };
    }

    default:
      return { ok: false, output: `❓ 未知命令: /${slash.command}` };
  }
}
