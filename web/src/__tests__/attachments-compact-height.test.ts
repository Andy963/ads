import { describe, it, expect } from "vitest";
import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";
import { readFile } from "node:fs/promises";

import MainChat from "../components/MainChat.vue";
import TaskBoard from "../components/TaskBoard.vue";
import TaskDetail from "../components/TaskDetail.vue";
import type { Attachment, ModelConfig, Task, TaskDetail as TaskDetailType } from "../api/types";

async function readSfc(relativeToThisTest: string): Promise<string> {
  const url = new URL(relativeToThisTest, import.meta.url);
  return readFile(url, "utf8");
}

function makeAttachment(id: string): Attachment {
  return {
    id,
    url: `/api/attachments/${id}`,
    sha256: "deadbeef",
    width: 100,
    height: 100,
    contentType: "image/png",
    sizeBytes: 123,
    filename: `${id}.png`,
  };
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

function makeTaskDetail(overrides: Partial<TaskDetailType>): TaskDetailType {
  const t = makeTask(overrides);
  return {
    ...t,
    plan: overrides.plan ?? [],
    messages: overrides.messages ?? [],
  };
}

const AttachmentThumbStub = defineComponent({
  name: "AttachmentThumb",
  props: {
    src: { type: String, required: true },
    href: { type: String, required: false },
    title: { type: String, required: false },
    alt: { type: String, required: false },
    width: { type: Number, required: false },
    height: { type: Number, required: false },
  },
  template: `<div class="thumbStub" :data-w="width" :data-h="height" />`,
});

describe("compact attachment UI", () => {
  it("MainChat keeps the compact attachments bar and clear remains clickable", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [{ data: "data:image/png;base64,AA==" }],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    const pill = wrapper.find(".attachmentsPill");
    expect(pill.exists()).toBe(true);
    const bar = wrapper.find(".attachmentsBar");
    expect(bar.exists()).toBe(true);

    await wrapper.find(".attachmentsClear").trigger("click");
    expect(wrapper.emitted("clearImages")).toBeTruthy();

    const sfc = await readSfc("../components/MainChat.vue");
    expect(sfc).toMatch(/\.attachmentsBar\s*\{[\s\S]*height:\s*10px\s*;/);
    expect(sfc).toMatch(/\.attachmentsPill\s*\{[\s\S]*height:\s*10px\s*;/);
    expect(sfc).toMatch(/\.attachmentsClear\s*\{[\s\S]*width:\s*10px\s*;[\s\S]*height:\s*10px\s*;/);

    wrapper.unmount();
  });

  it("TaskDetail uses 10x10 thumbs and keeps a compact strip", async () => {
    const task = makeTaskDetail({
      id: "t-1",
      status: "completed",
      attachments: [makeAttachment("a-1"), makeAttachment("a-2")],
    });

    const wrapper = mount(TaskDetail, {
      props: {
        task,
        messages: [],
      },
      global: {
        stubs: {
          MarkdownContent: true,
          AttachmentThumb: AttachmentThumbStub,
        },
      },
      attachTo: document.body,
    });

    const strip = wrapper.find(".attachmentsStrip");
    expect(strip.exists()).toBe(true);

    const thumbs = wrapper.findAll(".thumbStub");
    expect(thumbs).toHaveLength(2);
    for (const t of thumbs) {
      expect(t.attributes("data-w")).toBe("10");
      expect(t.attributes("data-h")).toBe("10");
    }

    const sfc = await readSfc("../components/TaskDetail.vue");
    expect(sfc).toMatch(/\.attachmentsStrip\s*\{[\s\S]*height:\s*10px\s*;/);

    wrapper.unmount();
  });

  it("TaskBoard does not render attachments inline", async () => {
    const task = makeTask({
      id: "t-1",
      title: "With attachments",
      status: "completed",
      attachments: [makeAttachment("a-1"), makeAttachment("a-2"), makeAttachment("a-3"), makeAttachment("a-4"), makeAttachment("a-5")],
    });
    const models: ModelConfig[] = [{ id: "auto", displayName: "Auto", provider: "", isEnabled: true, isDefault: true }];

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        models,
        selectedId: null,
        plans: new Map(),
        expanded: new Set(),
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      global: {
        stubs: {
          AttachmentThumb: AttachmentThumbStub,
        },
      },
      attachTo: document.body,
    });

    const row = wrapper.find(".attachmentsRow");
    expect(row.exists()).toBe(false);

    const links = wrapper.findAll(".attachmentLink");
    expect(links).toHaveLength(0);

    const thumbs = wrapper.findAll(".thumbStub");
    expect(thumbs).toHaveLength(0);

    const more = wrapper.find(".attachmentsMore");
    expect(more.exists()).toBe(false);

    wrapper.unmount();
  });
});
