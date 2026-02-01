import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectWorkspace } from "./detector.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "./adsPaths.js";
import { safeStringify } from "../utils/json.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_RULES_PATH = path.join(PROJECT_ROOT, "templates", "rules.md");

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function readRules(workspacePath?: string): Promise<string> {
  const workspace = workspacePath ? path.resolve(workspacePath) : detectWorkspace();
  migrateLegacyWorkspaceAdsIfNeeded(workspace);
  const workspaceRules = resolveWorkspaceStatePath(workspace, "rules.md");
  const templateRules = TEMPLATE_RULES_PATH;

  let source = "template";
  let targetPath = templateRules;
  let content = readFileIfExists(workspaceRules);

  if (content) {
    source = "workspace";
    targetPath = workspaceRules;
  } else {
    content = readFileIfExists(templateRules) ?? "";
  }

  const result = [
    "# 项目规则",
    "",
    `**来源**: ${source}`,
    `**路径**: ${targetPath}`,
    `**说明**: ${source === "workspace" ? "工作空间自定义规则（可编辑上面的路径）" : "默认模板规则（请先初始化工作空间以生成可编辑的规则文件）"}`,
    "",
    "---",
    "",
    content,
  ].join("\n");

  return result;
}

export async function listRules(params: { workspace_path?: string; category?: string }): Promise<string> {
  const { workspace_path: workspacePath, category } = params;
  const rulesContent = await readRules(workspacePath);

  const lines = rulesContent.split(/\r?\n/);
  const rules: Array<Record<string, unknown>> = [];
  let currentCategory: string | null = null;
  let currentRule: Record<string, unknown> | null = null;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      currentCategory = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("### ")) {
      if (currentRule) {
        rules.push(currentRule);
      }
      const title = line.slice(4).trim().replace(/^\d+\.\s*/, "");
      currentRule = {
        title,
        category: currentCategory,
        priority: currentCategory && currentCategory.includes("禁止") ? "critical" : "normal",
        description: "",
      };
      continue;
    }
    if (currentRule && line.startsWith("**规则**:")) {
      currentRule.description = line.slice("**规则**:".length).trim();
    }
  }

  if (currentRule) {
    rules.push(currentRule);
  }

  const filtered = category
    ? rules.filter((rule) =>
        String(rule.category ?? "")
          .toLowerCase()
          .includes(category.toLowerCase()),
      )
    : rules;

  return safeStringify({
    total: filtered.length,
    rules: filtered,
  });
}

export async function checkRuleViolation(params: {
  operation: string;
  details: Record<string, unknown>;
  workspace_path?: string;
}): Promise<string> {
  const { operation, details } = params;
  const violations: Array<Record<string, unknown>> = [];

  if (operation === "delete_file") {
    const filePath = String(details.file_path ?? "");
    if ([".db", ".sqlite", ".sqlite3", "index.json"].some((ext) => filePath.endsWith(ext))) {
      violations.push({
        rule: "禁止删除数据库文件",
        severity: "critical",
        message: `不得删除数据库文件: ${filePath}`,
        action: "stop",
      });
    }
  }

  if (operation === "git_commit") {
    const message = String(details.message ?? "");
    const explicit = details.user_explicit_request === true;
    if (!explicit) {
      violations.push({
        rule: "提交必须由用户显式请求",
        severity: "critical",
        message: "缺少用户明确授权，已阻止自动提交",
        action: "stop",
      });
    }
    if (message.includes("Co-authored-by")) {
      violations.push({
        rule: "禁止添加 Co-authored-by",
        severity: "critical",
        message: "提交信息中禁止包含 Co-authored-by",
        action: "stop",
      });
    }
  }

  return safeStringify({
    operation,
    violations,
    has_violation: violations.length > 0,
  });
}
