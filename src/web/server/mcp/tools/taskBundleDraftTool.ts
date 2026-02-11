import { z } from "zod";

import { ensureTaskBundleIdempotency, taskBundleSchema } from "../../planner/taskBundle.js";
import { upsertTaskBundleDraft, type TaskBundleDraft } from "../../planner/taskBundleDraftStore.js";

import type { McpTool } from "../types.js";

const toolArgsSchema = z.object({
  bundle: z.unknown(),
}).passthrough();

export const taskBundleDraftUpsertTool: McpTool = {
  descriptor: {
    name: "ads_task_bundle_draft_upsert",
    description: "Create or update a TaskBundle draft for later human approval in ADS Web UI.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      required: ["bundle"],
      properties: {
        bundle: {
          type: "object",
          additionalProperties: true,
          required: ["version", "tasks"],
          properties: {
            version: { const: 1 },
            requestId: { type: "string" },
            runQueue: { type: "boolean" },
            insertPosition: { type: "string", enum: ["front", "back"] },
            tasks: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: true,
                required: ["prompt"],
                properties: {
                  externalId: { type: "string" },
                  title: { type: "string" },
                  prompt: { type: "string" },
                  model: { type: "string" },
                  priority: { type: "number" },
                  inheritContext: { type: "boolean" },
                  maxRetries: { type: "number" },
                  attachments: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
  async call(args: unknown, ctx) {
    const parsed = toolArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: "Invalid tool arguments." }],
      };
    }

    const bundleParsed = taskBundleSchema.safeParse(parsed.data.bundle);
    if (!bundleParsed.success) {
      return {
        content: [{ type: "text", text: "Invalid TaskBundle schema." }],
      };
    }

    const defaultRequestId = (() => {
      const clientMessageId = String(ctx.auth.clientMessageId ?? "").trim();
      if (clientMessageId) return `cmid:${clientMessageId}`;
      const requestId = String(ctx.auth.requestId ?? "").trim();
      if (requestId) return `req:${requestId}`;
      const rpcId = ctx.rpcId;
      if (rpcId != null) return `rpc:${String(rpcId)}`;
      return null;
    })();

    const bundle = ensureTaskBundleIdempotency(bundleParsed.data, { defaultRequestId });

    let draft: TaskBundleDraft;
    try {
      draft = upsertTaskBundleDraft({
        authUserId: ctx.auth.authUserId,
        workspaceRoot: ctx.auth.workspaceRoot,
        sourceChatSessionId: ctx.auth.chatSessionId,
        sourceHistoryKey: ctx.auth.historyKey,
        bundle,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Failed to persist draft: ${message}` }],
      };
    }

    try {
      ctx.broadcastPlanner({ type: "task_bundle_draft", action: "upsert", draft });
    } catch {
      // ignore
    }

    const tasksCount = Array.isArray(draft.bundle?.tasks) ? draft.bundle?.tasks.length : 0;
    return {
      content: [
        { type: "text", text: `Draft upserted: id=${draft.id} tasks=${tasksCount}` },
        { type: "json", json: { draftId: draft.id, tasksCount } },
      ],
    };
  },
};
