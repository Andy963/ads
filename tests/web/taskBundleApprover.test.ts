import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkspaceAttachmentRawUrl,
  materializeTaskBundleTasks,
} from "../../server/web/server/planner/taskBundleApprover.js";

function createMetrics() {
  return {
    counts: {
      TASK_ADDED: 0,
      TASK_STARTED: 0,
      PROMPT_INJECTED: 0,
      TASK_COMPLETED: 0,
      INJECTION_SKIPPED: 0,
    },
    events: [] as Array<{ name: string; ts: number; taskId?: string; reason?: string }>,
  };
}

describe("planner/taskBundleApprover", () => {
  it("materializes attachments into task payloads and metrics", () => {
    const tasksById = new Map<string, any>();
    const attachmentsByTaskId = new Map<string, string[]>();
    const materialized: Array<{ task: { attachments?: Array<{ id: string; url: string }> } }> = [];
    const metrics = createMetrics();

    const result = materializeTaskBundleTasks({
      draftId: "draft-1",
      tasks: [{ prompt: "Review planner draft", attachments: ["att-1"] }],
      now: 123,
      taskStore: {
        createTask(input, now, options) {
          const task = {
            id: input.id ?? "task-1",
            title: input.title ?? "",
            prompt: input.prompt,
            model: input.model ?? "auto",
            status: options.status,
            priority: input.priority ?? 0,
            queueOrder: 0,
            inheritContext: input.inheritContext ?? true,
            retryCount: 0,
            maxRetries: input.maxRetries ?? 0,
            reviewRequired: true,
            reviewStatus: "pending",
            createdAt: now,
          };
          tasksById.set(task.id, task);
          return task;
        },
        getTask(id) {
          return tasksById.get(id) ?? null;
        },
        deleteTask(id) {
          tasksById.delete(id);
        },
      },
      attachmentStore: {
        assignAttachmentsToTask(taskId, attachmentIds) {
          attachmentsByTaskId.set(taskId, attachmentIds.slice());
        },
        listAttachmentsForTask(taskId) {
          return (attachmentsByTaskId.get(taskId) ?? []).map((id) => ({
            id,
            taskId,
            kind: "image" as const,
            filename: `${id}.png`,
            contentType: "image/png",
            sizeBytes: 42,
            width: 16,
            height: 9,
            sha256: "a".repeat(64),
            storageKey: `${id}.bin`,
            createdAt: 123,
          }));
        },
      },
      metrics,
      metricReason: "auto_approve",
      buildAttachmentUrl: (attachmentId) => buildWorkspaceAttachmentRawUrl("/tmp/ws-auto", attachmentId),
      onTaskMaterialized: (record) => materialized.push(record),
    });

    assert.equal(result.createdTaskIds.length, 1);
    assert.equal(result.taskTitles[0], "Review planner draft");
    assert.equal(metrics.counts.TASK_ADDED, 1);
    assert.equal(materialized.length, 1);
    assert.deepEqual(materialized[0]!.task.attachments, [
      {
        id: "att-1",
        url: "/api/attachments/att-1/raw?workspace=%2Ftmp%2Fws-auto",
        sha256: "a".repeat(64),
        width: 16,
        height: 9,
        contentType: "image/png",
        sizeBytes: 42,
        filename: "att-1.png",
      },
    ]);
  });

  it("does not delete an existing task when attachment assignment fails after duplicate create", () => {
    const existingTask = {
      id: "existing-task",
      title: "Existing",
      prompt: "Prompt",
      model: "auto",
      status: "queued",
      priority: 0,
      queueOrder: 0,
      inheritContext: true,
      retryCount: 0,
      maxRetries: 0,
      reviewRequired: true,
      reviewStatus: "pending",
      createdAt: 1,
    };
    let deleteCalls = 0;

    assert.throws(
      () =>
        materializeTaskBundleTasks({
          draftId: "draft-2",
          tasks: [{ externalId: "existing", prompt: "Existing", attachments: ["att-2"] }],
          now: 123,
          taskStore: {
            createTask() {
              throw new Error("duplicate");
            },
            getTask() {
              return existingTask as any;
            },
            deleteTask() {
              deleteCalls += 1;
            },
          },
          attachmentStore: {
            assignAttachmentsToTask() {
              throw new Error("attachment denied");
            },
            listAttachmentsForTask() {
              return [];
            },
          },
          metrics: createMetrics(),
          metricReason: "planner_draft",
        }),
      /Assign attachments failed/,
    );

    assert.equal(deleteCalls, 0);
  });
});
