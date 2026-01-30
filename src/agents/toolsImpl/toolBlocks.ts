import type { ToolExecutionContext } from "../tools/context.js";
import { createAbortError, isAbortError, throwIfAborted, truncate } from "../tools/shared.js";

import type { ToolCallSummary, ToolExecutionResult, ToolHooks, ToolInvocation, ToolResolutionOutcome } from "./types.js";
import { runTool } from "./runner.js";
import type { AgentRunResult } from "../types.js";

const TOOL_BLOCK_REGEX = /<<<tool\.([a-z0-9_-]+)[\t ]*\r?\n([\s\S]*?)>>>/gi;
const PARALLEL_TOOL_NAMES = new Set(["read", "grep", "find", "search", "vsearch"]);
const PARALLEL_TOOL_CONCURRENCY = 6;

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    (async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          break;
        }
        results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
      }
    })(),
  );

  await Promise.all(runners);
  return results;
}

function extractToolInvocations(text: string): ToolInvocation[] {
  const matches: ToolInvocation[] = [];
  let match: RegExpExecArray | null;
  while ((match = TOOL_BLOCK_REGEX.exec(text)) !== null) {
    matches.push({
      name: (match[1] ?? "").trim().toLowerCase(),
      raw: match[0],
      payload: (match[2] ?? "").trim(),
    });
  }
  return matches;
}

export function stripToolBlocks(text: string): string {
  if (!text) {
    return text;
  }
  const regex = new RegExp(TOOL_BLOCK_REGEX.source, TOOL_BLOCK_REGEX.flags);
  const stripped = text.replace(regex, "").trim();
  return stripped.replace(/\n{3,}/g, "\n\n");
}

async function executeInvocation(
  invocation: ToolInvocation,
  context: ToolExecutionContext,
): Promise<{ invocation: ToolInvocation; result: ToolExecutionResult; summary: ToolCallSummary }> {
  throwIfAborted(context.signal);
  try {
    throwIfAborted(context.signal);
    const output = await runTool(invocation.name, invocation.payload, context);
    return {
      invocation,
      result: { tool: invocation.name, payload: invocation.payload, ok: true, output },
      summary: {
        tool: invocation.name,
        ok: true,
        inputPreview: truncate(invocation.payload),
        outputPreview: truncate(output),
      },
    };
  } catch (error) {
    if (context.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : createAbortError();
    }
    const message = error instanceof Error ? error.message : String(error);
    const fallback = `⚠️ 工具 ${invocation.name} 失败：${message}`;
    return {
      invocation,
      result: {
        tool: invocation.name,
        payload: invocation.payload,
        ok: false,
        output: fallback,
        error: message,
      },
      summary: {
        tool: invocation.name,
        ok: false,
        inputPreview: truncate(invocation.payload),
        outputPreview: truncate(fallback),
      },
    };
  }
}

export async function executeToolBlocks(
  text: string,
  hooks?: ToolHooks,
  context: ToolExecutionContext = {},
): Promise<{ replacedText: string; strippedText: string; results: ToolExecutionResult[]; summaries: ToolCallSummary[] }> {
  const invocations = extractToolInvocations(text);
  if (invocations.length === 0) {
    return { replacedText: text, strippedText: text, results: [], summaries: [] };
  }

  const results: ToolExecutionResult[] = [];
  const summaries: ToolCallSummary[] = [];
  let replacedText = text;

  let idx = 0;
  while (idx < invocations.length) {
    const current = invocations[idx]!;

    if (!PARALLEL_TOOL_NAMES.has(current.name)) {
      throwIfAborted(context.signal);
      await hooks?.onInvoke?.(current.name, current.payload);
      const item = await executeInvocation(current, context);
      replacedText = replacedText.replace(item.invocation.raw, item.result.output);
      results.push(item.result);
      summaries.push(item.summary);
      await hooks?.onResult?.(item.summary);
      idx += 1;
      continue;
    }

    const batch: ToolInvocation[] = [];
    while (idx < invocations.length && PARALLEL_TOOL_NAMES.has(invocations[idx]!.name)) {
      batch.push(invocations[idx]!);
      idx += 1;
    }

    for (const invocation of batch) {
      throwIfAborted(context.signal);
      await hooks?.onInvoke?.(invocation.name, invocation.payload);
    }

    const batchResults = await runWithConcurrency(batch, PARALLEL_TOOL_CONCURRENCY, (invocation) => executeInvocation(invocation, context));
    for (const item of batchResults) {
      replacedText = replacedText.replace(item.invocation.raw, item.result.output);
      results.push(item.result);
      summaries.push(item.summary);
      await hooks?.onResult?.(item.summary);
    }
  }

  return { replacedText, strippedText: stripToolBlocks(text), results, summaries };
}

export async function resolveToolInvocations(
  result: AgentRunResult,
  hooks?: ToolHooks,
  context: ToolExecutionContext = {},
): Promise<ToolResolutionOutcome> {
  const outcome = await executeToolBlocks(result.response, hooks, context);

  return {
    response: outcome.replacedText,
    usage: result.usage,
    agentId: result.agentId,
    toolSummaries: outcome.summaries,
  };
}

