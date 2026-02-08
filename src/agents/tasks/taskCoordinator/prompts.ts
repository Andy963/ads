import type { TaskResult, TaskSpec } from "../schemas.js";

import { truncate } from "./helpers.js";

export function buildDelegatePrompt(spec: TaskSpec, revisionNote?: string | null): string {
  const note = String(revisionNote ?? "").trim();
  const noteSection = note ? `\n\nRevisionRequest:\n${note}` : "";

  return [
    "你是协作代理。请严格按要求输出结果：",
    "- 你可以使用你所在 CLI 的内置工具来读写文件/执行命令（由 CLI 自行完成）。",
    "- 不要输出 <<<agent.*>>> 指令块（禁止再委派给其它 agent）。",
    "- 当你认为任务已完成时，你的最后一条回复必须包含且只包含一个 TaskResult JSON（放在 ```json 代码块中）。",
    "- 如果信息不足，请返回 status=\"needs_clarification\" 并在 questions 中列出需要澄清的问题。",
    "",
    "TaskResult JSON schema (example):",
    "```json",
    JSON.stringify(
      {
        taskId: spec.taskId,
        revision: spec.revision,
        status: "submitted",
        summary: "…",
        changedFiles: [],
        howToVerify: [],
        knownRisks: [],
        questions: [],
      },
      null,
      2,
    ),
    "```",
    "",
    "TaskSpec:",
    "```json",
    JSON.stringify(spec, null, 2),
    "```",
    noteSection,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildVerdictPrompt(options: {
  supervisorName: string;
  round: number;
  summaries: Array<{ spec: TaskSpec; result: TaskResult | null; verificationText: string }>;
}): string {
  const header = [
    "系统已执行协作任务并自动运行了可用的验证命令，下面是每个任务的结果。",
    `你仍然是主管（${options.supervisorName}）：请基于结果进行验收（accept/reject）。`,
    "要求：",
    "- 你必须输出可机器解析的 SupervisorVerdict JSON（可放在 ```json 代码块中）。",
    "- 每个 taskId 必须给出 accept=true/false 与 note。",
    "- reject 时，note 必须包含：不符合点 + 期望如何改 + 如何验证。",
    "",
    `（协作轮次：${options.round}）`,
  ].join("\n");

  const body = options.summaries
    .map((entry, idx) => {
      const resultJson = entry.result ? JSON.stringify(entry.result, null, 2) : "(no TaskResult parsed)";
      return [
        "---",
        `【任务 ${idx + 1}】taskId=${entry.spec.taskId} agent=${entry.spec.agentId} revision=${entry.spec.revision}`,
        `goal: ${truncate(entry.spec.goal, 240)}`,
        "",
        "TaskResult:",
        "```json",
        truncate(resultJson, 2200),
        "```",
        "",
        "Auto verification:",
        "```",
        truncate(entry.verificationText, 1400),
        "```",
      ].join("\n");
    })
    .join("\n\n");

  const tail = [
    "",
    "请输出 SupervisorVerdict JSON，例如：",
    "```json",
    JSON.stringify(
      {
        verdicts: options.summaries.map((entry) => ({ taskId: entry.spec.taskId, accept: true, note: "ok" })),
      },
      null,
      2,
    ),
    "```",
  ].join("\n");

  return [header, body, tail].filter(Boolean).join("\n\n").trim();
}
