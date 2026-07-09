import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";
import TaskBoard from "../components/TaskBoard.vue";
import type { Attachment, Task } from "../api/types";
import { readSfc } from "./readSfc";

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
    agentId: overrides.agentId ?? null,
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

describe("compact attachment UI", () => {
  it("MainChat renders thumbnail previews with clear action", async () => {
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

    const bar = wrapper.find(".attachmentsBar");
    expect(bar.exists()).toBe(true);
    const thumb = wrapper.find(".attachmentsThumb");
    expect(thumb.exists()).toBe(true);

    await wrapper.find(".attachmentsClear").trigger("click");
    expect(wrapper.emitted("clearImages")).toBeTruthy();

    const sfc = await readSfc("../components/MainChatComposerPanel.vue", import.meta.url);
    expect(sfc).toMatch(/\.attachmentsBar\s*\{[\s\S]*min-height:\s*28px\s*;/);
    expect(sfc).toMatch(/\.attachmentsThumb\s*\{[\s\S]*width:\s*36px\s*;[\s\S]*height:\s*24px\s*;/);
    expect(sfc).toMatch(/\.attachmentsClear\s*\{[\s\S]*width:\s*26px\s*;[\s\S]*height:\s*26px\s*;/);

    wrapper.unmount();
  });

  it("TaskBoard does not render attachments inline", async () => {
    const task = makeTask({
      id: "t-1",
      title: "With attachments",
      status: "completed",
      attachments: [makeAttachment("a-1"), makeAttachment("a-2"), makeAttachment("a-3"), makeAttachment("a-4"), makeAttachment("a-5")],
    });

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        agents: [],
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      global: {
        stubs: {
          // Element Plus component used by TaskBoard; stub to avoid global plugin wiring in this unit test.
          "el-icon": true,
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
