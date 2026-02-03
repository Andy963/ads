import { z } from "zod";

import type { AgentEvent } from "../../../../../codex/events.js";

import type { ApiRouteContext, ApiSharedDeps } from "../../types.js";
import { readJsonBody, sendJson } from "../../../http.js";
import { selectAgentForModel } from "./shared.js";

export async function handleTaskChatRoute(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  const chatMatch = /^\/api\/tasks\/([^/]+)\/chat$/.exec(pathname);
  if (!chatMatch || req.method !== "POST") {
    return false;
  }

  if (!deps.taskQueueAvailable) {
    sendJson(res, 409, { error: "Task queue disabled" });
    return true;
  }

  let taskCtx;
  try {
    taskCtx = deps.resolveTaskContext(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, { error: message });
    return true;
  }

  const taskId = chatMatch[1] ?? "";
  const task = taskCtx.taskStore.getTask(taskId);
  if (!task) {
    sendJson(res, 404, { error: "Not Found" });
    return true;
  }
  if (task.status === "cancelled") {
    sendJson(res, 409, { error: "Task is cancelled" });
    return true;
  }

  const body = await readJsonBody(req);
  const schema = z.object({ content: z.string().min(1) }).passthrough();
  const parsed = schema.parse(body ?? {});
  const content = String(parsed.content ?? "").trim();
  if (!content) {
    sendJson(res, 400, { error: "Empty message" });
    return true;
  }

  try {
    taskCtx.taskStore.addMessage({
      taskId: task.id,
      planStepId: null,
      role: "user",
      content,
      messageType: "chat",
      modelUsed: null,
      tokenCount: null,
      createdAt: Date.now(),
    });
  } catch {
    // ignore
  }
  deps.broadcastToSession(taskCtx.sessionId, {
    type: "task:event",
    event: "message",
    data: { taskId: task.id, role: "user", content },
    ts: Date.now(),
  });

  void taskCtx.lock.runExclusive(async () => {
    const latest = taskCtx.taskStore.getTask(taskId);
    if (!latest || latest.status === "cancelled") {
      return;
    }
    const desiredModel = String(latest.model ?? "").trim() || "auto";
    const modelToUse = desiredModel === "auto" ? (process.env.TASK_QUEUE_DEFAULT_MODEL ?? "gpt-5.2") : desiredModel;
    const orchestrator = taskCtx.getTaskQueueOrchestrator(latest);
    orchestrator.setModel(modelToUse);
    const agentId = selectAgentForModel(modelToUse);

    let lastRespondingText = "";
    const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
      try {
        if (event.phase === "responding" && typeof event.delta === "string" && event.delta) {
          const next = event.delta;
          let delta = next;
          if (lastRespondingText && next.startsWith(lastRespondingText)) {
            delta = next.slice(lastRespondingText.length);
          }
          if (next.length >= lastRespondingText.length) {
            lastRespondingText = next;
          }
          if (delta) {
            deps.broadcastToSession(taskCtx.sessionId, {
              type: "task:event",
              event: "message:delta",
              data: { taskId: latest.id, role: "assistant", delta, modelUsed: modelToUse, source: "chat" },
              ts: Date.now(),
            });
          }
          return;
        }
        if (event.phase === "command" && event.title === "执行命令" && event.detail) {
          const command = String(event.detail).split(" | ")[0]?.trim();
          if (command) {
            try {
              taskCtx.taskStore.addMessage({
                taskId: latest.id,
                planStepId: null,
                role: "system",
                content: `$ ${command}`,
                messageType: "command",
                modelUsed: null,
                tokenCount: null,
                createdAt: Date.now(),
              });
            } catch {
              // ignore
            }
            deps.broadcastToSession(taskCtx.sessionId, {
              type: "task:event",
              event: "command",
              data: { taskId: latest.id, command },
              ts: Date.now(),
            });
          }
        }
      } catch {
        // ignore
      }
    });

    try {
      const prompt = [
        "你是一个正在执行任务的开发助手。",
        `任务标题: ${latest.title}`,
        `任务描述: ${latest.prompt}`,
        "",
        "用户追加指令：",
        content,
      ].join("\n");

      const result = await orchestrator.invokeAgent(agentId, prompt, { streaming: true });
      const text = typeof result.response === "string" ? result.response : String(result.response ?? "");
      try {
        taskCtx.taskStore.addMessage({
          taskId: latest.id,
          planStepId: null,
          role: "assistant",
          content: text,
          messageType: "chat",
          modelUsed: modelToUse,
          tokenCount: null,
          createdAt: Date.now(),
        });
      } catch {
        // ignore
      }
      deps.broadcastToSession(taskCtx.sessionId, {
        type: "task:event",
        event: "message",
        data: { taskId: latest.id, role: "assistant", content: text },
        ts: Date.now(),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.broadcastToSession(taskCtx.sessionId, {
        type: "task:event",
        event: "message",
        data: { taskId, role: "system", content: `[Chat failed] ${msg}` },
        ts: Date.now(),
      });
    } finally {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
  });

  sendJson(res, 200, { success: true });
  return true;
}
