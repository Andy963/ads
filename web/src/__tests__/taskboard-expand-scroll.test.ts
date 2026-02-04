import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import TaskBoard from "../components/TaskBoard.vue";
import type { ModelConfig, Task } from "../api/types";
import { readSfc } from "./readSfc";

function makeTask(overrides: Partial<Task>): Task {
  const now = Date.now();
  return {
    id: overrides.id ?? `t-${now}`,
    title: overrides.title ?? "Test Task",
    prompt: overrides.prompt ?? "Do something",
    model: overrides.model ?? "auto",
    status: overrides.status ?? "completed",
    priority: overrides.priority ?? 0,
    queueOrder: overrides.queueOrder ?? 0,
    inheritContext: overrides.inheritContext ?? true,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 0,
    createdAt: overrides.createdAt ?? now,
    queuedAt: overrides.queuedAt ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    createdBy: overrides.createdBy ?? null,
    attachments: overrides.attachments,
  };
}

describe("TaskBoard plan removal", () => {
  it("does not render any plan panel/toggle DOM", async () => {
    const task = makeTask({ id: "t-1", title: "A", status: "completed" });
    const models: ModelConfig[] = [{ id: "auto", displayName: "Auto", provider: "", isEnabled: true, isDefault: true }];

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        models,
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      global: {
        stubs: {
          AttachmentThumb: true,
          // Element Plus component used by TaskBoard; stub to avoid global plugin wiring in this unit test.
          "el-icon": true,
        },
      },
      attachTo: document.body,
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".plan").exists()).toBe(false);
    expect(wrapper.find(".plan-title").exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not ship plan CSS hooks", async () => {
    const sfc = await readSfc("../components/TaskBoard.vue", import.meta.url);
    expect(sfc).not.toMatch(/\.plan\b/);
    expect(sfc).not.toMatch(/plan-title/);
  });
});
