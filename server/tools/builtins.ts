import type { NativeToolDefinition } from "../runtime/openAiCompatibleClient.js";
import type { ActionJobStatus } from "../state/actionJobStore.js";
import { getBus } from "../web/server/api/routes/actions.js";

export const BUILTIN_TOOL_DEFINITIONS: NativeToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "dispatch_action_job",
      description: "Dispatch an approved GitHub Issue or task prompt to the background Actions execution queue.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          issue_id: { type: "integer", minimum: 1, description: "GitHub Issue number if available." },
          title: { type: "string", minLength: 1, description: "Task or Issue title." },
          description: { type: "string", minLength: 1, description: "Complete Issue description or local task prompt." },
          acceptance_criteria: { type: "array", items: { type: "string", minLength: 1 }, description: "Immutable acceptance criteria snapshot. GitHub Issues require at least one criterion; local prompts may use an empty array." },
          kind: { type: "string", enum: ["github_issue", "local_prompt"], description: "Kind of task; defaults to github_issue." },
        },
        required: ["title", "description", "acceptance_criteria"],
      },
    },
  },
];

export interface BuiltinToolContext {
  workspaceRoot: string;
  authUserId?: string;
  signal?: AbortSignal;
}

export interface BuiltinToolResult {
  ok: boolean;
  job_id: string;
  status: ActionJobStatus;
  message: string;
}

const DISPATCH_ARGUMENTS = new Set(["issue_id", "title", "description", "acceptance_criteria", "kind"]);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export function executeBuiltinTool(name: string, args: unknown, context: BuiltinToolContext): BuiltinToolResult {
  throwIfAborted(context.signal);
  if (name !== "dispatch_action_job") throw new Error("Unknown built-in tool");
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  const input = args as Record<string, unknown>;
  if (Object.keys(input).some((key) => !DISPATCH_ARGUMENTS.has(key))) {
    throw new Error("dispatch_action_job does not accept additional arguments");
  }
  // Preserve the text directive's missing-field contract at the shared boundary.
  if (!Object.hasOwn(input, "acceptance_criteria")) {
    throw new Error("dispatch_action_job requires an explicit acceptance_criteria field");
  }
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new Error("Tool argument title is required");
  }
  if (typeof input.description !== "string" || !input.description.trim()) {
    throw new Error("Tool argument description is required");
  }
  const kind = Object.hasOwn(input, "kind") ? input.kind : "github_issue";
  if (kind !== "github_issue" && kind !== "local_prompt") {
    throw new Error("Tool argument kind must be github_issue or local_prompt");
  }
  if (!Array.isArray(input.acceptance_criteria)
    || input.acceptance_criteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())) {
    throw new Error("Tool argument acceptance_criteria must be an array of nonempty strings");
  }
  const acceptanceCriteria = (input.acceptance_criteria as string[]).map((criterion) => criterion.trim());
  if (kind === "github_issue" && acceptanceCriteria.length === 0) {
    throw new Error("dispatch_action_job requires a complete description and acceptance criteria");
  }
  const issueId = Object.hasOwn(input, "issue_id") ? input.issue_id : null;
  if (Object.hasOwn(input, "issue_id")
    && (typeof issueId !== "number" || !Number.isSafeInteger(issueId) || issueId <= 0)) {
    throw new Error("Tool argument issue_id must be a positive integer");
  }
  if (!context.workspaceRoot.trim()) throw new Error("Built-in tool workspace is required");

  throwIfAborted(context.signal);
  try {
    const bus = getBus();
    // Queue persistence is a side effect; never forward an abort reason or raw bus error.
    throwIfAborted(context.signal);
    const result = bus.dispatchJob({
      projectId: context.workspaceRoot,
      repoPath: context.workspaceRoot,
      authUserId: context.authUserId,
      issueId: issueId as number | null,
      issueTitle: input.title.trim(),
      issueDescription: input.description.trim(),
      acceptanceCriteria,
      jobKind: kind,
    });
    return {
      ok: result.ok,
      job_id: result.jobId,
      status: result.status,
      message: `Dispatched task to Actions queue with status '${result.status}'`,
    };
  } catch {
    throwIfAborted(context.signal);
    throw new Error("Unable to dispatch Actions job");
  }
}
