import path from "node:path";
import { promises as fs } from "node:fs";

import { createWorkflowFromTemplate } from "../workflow/templateService.js";
import { WorkflowContext } from "../workspace/context.js";
import { detectWorkspace } from "../workspace/detector.js";
import { getNodeById } from "../graph/crud.js";
import { getSpecDir } from "../graph/fileManager.js";
import { INTAKE_FIELDS, type IntakeFieldKey, type IntakeResult, type IntakeState } from "./types.js";
import { clearIntakeState, loadIntakeState, saveIntakeState } from "./storage.js";

const SUMMARY_START = "<!-- intake:auto:start -->";
const SUMMARY_END = "<!-- intake:auto:end -->";

function nowIso(): string {
  return new Date().toISOString();
}

function generateTitleFromInput(input: string): string {
  const trimmed = input.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "新需求";
  }
  return trimmed.length <= 24 ? trimmed : `${trimmed.slice(0, 24)}…`;
}

function escapeMultiline(value: string | undefined): string {
  if (!value) {
    return "（待补充）";
  }
  const normalized = value.trim();
  if (!normalized) {
    return "（待补充）";
  }
  return normalized.replace(/\r?\n/g, "\n  ");
}

function buildSummaryBlock(state: IntakeState): string {
  const fieldMap = INTAKE_FIELDS.reduce<Record<IntakeFieldKey, string>>((acc, field) => {
    acc[field.key] = escapeMultiline(state.fields[field.key]);
    return acc;
  }, {} as Record<IntakeFieldKey, string>);

  const lines = [
    SUMMARY_START,
    "## Intake Summary (自动生成)",
    "",
    `- 原始需求：${escapeMultiline(state.originalInput)}`,
    `- 目标：${fieldMap.goal}`,
    `- 背景：${fieldMap.background}`,
    `- 范围：${fieldMap.scope}`,
    `- 约束：${fieldMap.constraints}`,
    `- 验收标准：${fieldMap.acceptance}`,
    "",
    SUMMARY_END,
  ];

  return lines.join("\n");
}

async function updateRequirementSummary(specDir: string, state: IntakeState): Promise<void> {
  const filePath = path.join(specDir, "requirements.md");
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.writeFile(filePath, "", "utf-8");
      content = "";
    } else {
      throw error;
    }
  }

  const summaryBlock = buildSummaryBlock(state);
  if (content.includes(SUMMARY_START) && content.includes(SUMMARY_END)) {
    const pattern = new RegExp(`${SUMMARY_START}[\s\S]*?${SUMMARY_END}`);
    content = content.replace(pattern, summaryBlock);
  } else {
    content = `${summaryBlock}\n\n${content}`.trimEnd();
  }

  await fs.writeFile(filePath, content, "utf-8");
}

function nextPendingField(state: IntakeState): IntakeFieldKey | null {
  return state.pending.length > 0 ? state.pending[0] : null;
}

export async function getActiveIntakeState(): Promise<IntakeState | null> {
  return loadIntakeState();
}

export async function startIntake(initialInput: string): Promise<IntakeResult> {
  const workspace = detectWorkspace();
  const title = generateTitleFromInput(initialInput);
  const description = initialInput.trim();

  const responseJson = await createWorkflowFromTemplate({
    title,
    description,
  });

  const parsed = JSON.parse(responseJson) as Record<string, unknown>;
  if (!parsed.success) {
    const message = typeof parsed.message === "string" ? parsed.message : "创建工作流失败";
    return {
      messages: [`❌ ${message}`],
      done: true,
    };
  }

  const workflow = WorkflowContext.getActiveWorkflow(workspace);
  if (!workflow) {
    return {
      messages: ["❌ 无法读取新建的工作流上下文"],
      done: true,
    };
  }

  const rootNode = getNodeById(workflow.workflow_id);
  if (!rootNode) {
    return {
      messages: ["❌ 未找到工作流根节点"],
      done: true,
    };
  }

  const specDir = getSpecDir(rootNode, workspace);

  const pending: IntakeFieldKey[] = INTAKE_FIELDS.map((field) => field.key).filter((key) => key !== "goal");
  const state: IntakeState = {
    workflowId: workflow.workflow_id,
    workflowTitle: workflow.title ?? title,
    specDir,
    originalInput: initialInput,
    fields: {
      goal: initialInput.trim(),
    },
    pending,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await saveIntakeState(state, workspace);
  await updateRequirementSummary(specDir, state);

  const nextField = nextPendingField(state);
  const nextQuestion = nextField
    ? INTAKE_FIELDS.find((field) => field.key === nextField)?.question ?? "请补充更多细节"
    : null;

  const messages = [
    `✅ 已创建工作流「${state.workflowTitle}」，需求文档目录：${path.relative(workspace, specDir)}`,
    "已记录初始需求描述。",
  ];

  if (nextQuestion) {
    messages.push(`请继续补充：${nextQuestion}`);
  } else {
    messages.push("需求信息已完整，无需补充。");
  }

  return {
    messages,
    done: nextQuestion === null,
  };
}

export async function handleIntakeAnswer(answer: string): Promise<IntakeResult> {
  const workspace = detectWorkspace();
  const state = await loadIntakeState(workspace);
  if (!state) {
    return {
      messages: ["⚠️ 当前没有进行中的需求澄清流程。"],
      done: true,
    };
  }

  const currentFieldKey = nextPendingField(state);
  if (!currentFieldKey) {
    await clearIntakeState(workspace);
    return {
      messages: ["✅ 需求已记录，无需继续补充。"],
      done: true,
    };
  }

  const trimmed = answer.trim();
  state.fields[currentFieldKey] = trimmed || "（未提供）";
  state.pending = state.pending.filter((key) => key !== currentFieldKey);
  state.updatedAt = nowIso();

  await saveIntakeState(state, workspace);
  await updateRequirementSummary(state.specDir, state);

  const nextField = nextPendingField(state);
  if (!nextField) {
    await clearIntakeState(workspace);
    const summary = [
      "✅ 所有必填信息已补齐，需求文档已更新。",
      "可继续完善设计 / 实施或直接与 Codex 讨论下一步。",
    ];
    return {
      messages: summary,
      done: true,
    };
  }

  const nextQuestion = INTAKE_FIELDS.find((field) => field.key === nextField)?.question ?? "请继续补充相关信息。";
  return {
    messages: ["已记录。", `请继续补充：${nextQuestion}`],
    done: false,
  };
}

export async function cancelIntake(): Promise<IntakeResult> {
  const workspace = detectWorkspace();
  const state = await loadIntakeState(workspace);
  if (!state) {
    return {
      messages: ["当前没有进行中的需求澄清流程。"],
      done: true,
    };
  }

  await clearIntakeState(workspace);
  return {
    messages: ["已取消当前需求澄清流程，可继续正常对话。"],
    done: true,
  };
}
