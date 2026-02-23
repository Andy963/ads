import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import TaskDetail from "../components/TaskDetail.vue";
import type { TaskDetail as TaskDetailType } from "../api/types";

describe("TaskDetail Accessibility", () => {
  const mockTask: TaskDetailType = {
    id: "task-1",
    title: "Test Task",
    status: "pending",
    model: "gpt-4",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    priority: 0,
    maxRetries: 3,
    prompt: "Test prompt",
    agentId: "agent-1",
    attachments: [],
    history: []
  };

  it("renders aria-labels on action buttons", () => {
    const wrapper = mount(TaskDetail, {
      props: {
        task: mockTask,
        messages: [],
        apiToken: "test-token",
      },
    });

    const refreshBtn = wrapper.find('button[title="刷新"]');
    expect(refreshBtn.attributes("aria-label")).toBe("刷新任务");

    const cancelBtn = wrapper.find('button[title="终止"]');
    expect(cancelBtn.attributes("aria-label")).toBe("终止任务");

    const retryBtn = wrapper.find('button[title="重试"]');
    expect(retryBtn.attributes("aria-label")).toBe("重试任务");

    const deleteBtn = wrapper.find('button[title="删除任务"]');
    expect(deleteBtn.attributes("aria-label")).toBe("删除任务");
  });

  it("renders aria-label on status container", () => {
    const wrapper = mount(TaskDetail, {
      props: {
        task: mockTask,
        messages: [],
        apiToken: "test-token",
      },
    });

    const status = wrapper.find(".status");
    expect(status.attributes("aria-label")).toBe("状态: pending");
    expect(status.attributes("role")).toBe("img");
  });

  it("renders aria-labels on composer inputs", () => {
    const wrapper = mount(TaskDetail, {
      props: {
        task: mockTask,
        messages: [],
        apiToken: "test-token",
      },
    });

    const textarea = wrapper.find("textarea.composer-input");
    expect(textarea.attributes("aria-label")).toBe("输入指令");

    const sendBtn = wrapper.find("button.send");
    expect(sendBtn.attributes("aria-label")).toBe("发送指令");
  });
});
