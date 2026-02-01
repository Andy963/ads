import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

import TaskBoard from "../components/TaskBoard.vue";
import type { ModelConfig, PlanStep, Task } from "../api/types";
import { readSfc } from "./readSfc";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

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

function makeStep(overrides: Partial<PlanStep>): PlanStep {
  return {
    id: overrides.id ?? 1,
    taskId: overrides.taskId ?? "t-1",
    stepNumber: overrides.stepNumber ?? 1,
    title: overrides.title ?? "Step title",
    description: overrides.description ?? null,
    status: overrides.status ?? "pending",
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
  };
}

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

describe("TaskBoard plan expansion", () => {
  it("scrolls the expanded task into view inside the list container", async () => {
    const task = makeTask({ id: "t-1", title: "A", status: "completed" });
    const models: ModelConfig[] = [{ id: "auto", displayName: "Auto", provider: "", isEnabled: true, isDefault: true }];
    const plans = new Map<string, PlanStep[]>([
      [task.id, [makeStep({ taskId: task.id, title: "A very long step title that should not be truncated silently" })]],
    ]);

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        models,
        selectedId: null,
        plans,
        expanded: new Set<string>(),
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
    await settleUi(wrapper);

    const list = wrapper.find(".list").element as HTMLElement;

    // JSDOM doesn't do layout; stub rects and scrolling APIs so the component logic can be tested.
    // The component scrolls the expanded ".plan" element into view, so return a rect for ".plan"
    // even though it doesn't exist until expansion happens.
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("list")) return rect(0, 100);
        if (this.classList.contains("plan")) return rect(80, 160);
        return rect(0, 0);
      });

    list.scrollTop = 0;
    // @ts-expect-error - JSDOM HTMLElement may not type scrollTo in all versions.
    list.scrollTo = ({ top }: { top: number }) => {
      list.scrollTop = top;
    };

    await wrapper.setProps({ expanded: new Set<string>([task.id]) });
    await settleUi(wrapper);

    expect(list.scrollTop).toBeGreaterThan(0);
    expect(wrapper.find(".item").classes()).toContain("expanded");
    expect(wrapper.find(".plan").exists()).toBe(true);

    const title = wrapper.find(".plan-title");
    expect(title.attributes("title")).toContain("A very long step title");

    rectSpy.mockRestore();
    wrapper.unmount();
  });

  it("keeps the plan panel height bounded and scrollable", async () => {
    const sfc = await readSfc("../components/TaskBoard.vue", import.meta.url);
    expect(sfc).toMatch(/\.plan\s*\{[\s\S]*max-height:\s*min\(40vh,\s*320px\)\s*;/);
    expect(sfc).toMatch(/\.plan\s*\{[\s\S]*overflow-y:\s*auto\s*;/);
    expect(sfc).toMatch(/\.plan\s*\{[\s\S]*scrollbar-gutter:\s*stable\s*;/);
  });
});
