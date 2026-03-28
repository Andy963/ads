import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import MainChat from "../components/MainChat.vue";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, relFromThisFile);
  return fs.readFileSync(p, "utf8");
}

describe("MainChat header UI", () => {
  it("does not render a busy label in the header", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: true,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
    });

    expect(wrapper.text().toLowerCase()).not.toContain("busy");
    wrapper.unmount();
  });

  it("does not render the legacy empty header container", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
    });

    expect(wrapper.find(".header").exists()).toBe(false);
    wrapper.unmount();
  });

  it("only toggles the active chat class without restoring the legacy transparent top border", () => {
    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.detail\s*\{[\s\S]*?border-top:\s*none\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.detail--active\s*\{[\s\S]*?border-top-color:\s*#22c55e\s*;[\s\S]*?\}/);

    const baseProps = {
      queuedPrompts: [],
      pendingImages: [],
      connected: true,
    };

    const idle = mount(MainChat, {
      props: {
        ...baseProps,
        messages: [],
        busy: false,
      },
      global: { stubs: { MarkdownContent: true } },
    });
    expect(idle.classes()).not.toContain("detail--active");
    idle.unmount();

    const busy = mount(MainChat, {
      props: {
        ...baseProps,
        messages: [],
        busy: true,
      },
      global: { stubs: { MarkdownContent: true } },
    });
    expect(busy.classes()).toContain("detail--active");
    busy.unmount();

    const withHistory = mount(MainChat, {
      props: {
        ...baseProps,
        messages: [{ id: "m-1", role: "user", kind: "text", content: "Hello" }],
        busy: false,
      },
      global: { stubs: { MarkdownContent: true } },
    });
    expect(withHistory.classes()).not.toContain("detail--active");
    withHistory.unmount();
  });

  it("renders a green top border on the chat detail container", () => {
    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.detail--active\s*\{[\s\S]*?border-top-color:\s*#22c55e\s*;[\s\S]*?\}/);
  });

  it("renders an optional header action button and emits newSession", async () => {
    const wrapper = mount(MainChat, {
      props: {
        title: "Worker",
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        headerAction: { title: "New session", testId: "worker-chat-new-session" },
        headerResumeAction: { title: "Resume context", testId: "worker-chat-resume-thread" },
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
    });

    const resumeBtn = wrapper.find('[data-testid="worker-chat-resume-thread"]');
    expect(resumeBtn.exists()).toBe(true);
    await resumeBtn.trigger("click");
    expect(wrapper.emitted("resumeThread")?.length ?? 0).toBe(1);

    const btn = wrapper.find('[data-testid="worker-chat-new-session"]');
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    expect(wrapper.emitted("newSession")?.length ?? 0).toBe(1);
    wrapper.unmount();
  });

  it("disables the header action button while busy", () => {
    const wrapper = mount(MainChat, {
      props: {
        title: "Planner",
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: true,
        headerAction: { title: "Clear", testId: "planner-chat-clear-context" },
        headerResumeAction: { title: "Resume", testId: "planner-chat-resume-thread" },
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
    });

    const resumeBtn = wrapper.find('[data-testid="planner-chat-resume-thread"]');
    expect(resumeBtn.exists()).toBe(true);
    expect(resumeBtn.attributes("disabled")).toBeDefined();

    const btn = wrapper.find('[data-testid="planner-chat-clear-context"]');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("disables the resume button when action-disabled is true", () => {
    const wrapper = mount(MainChat, {
      props: {
        title: "Planner",
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        headerResumeAction: { title: "Resume", testId: "planner-chat-resume-thread", disabled: true },
      },
      global: { stubs: { MarkdownContent: true } },
    });

    const btn = wrapper.find('[data-testid="planner-chat-resume-thread"]');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("renders thread warnings inside the header instead of a separate banner", () => {
    const warning = "Context thread was reset (expected=thread-old, actual=thread-new).";
    const wrapper = mount(MainChat, {
      props: {
        title: "Worker",
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        threadWarning: warning,
      },
      global: { stubs: { MarkdownContent: true } },
    });

    const headerWarning = wrapper.find('[data-testid="main-chat-thread-warning"]');
    expect(headerWarning.exists()).toBe(true);
    expect(headerWarning.text()).toContain(warning);
    expect(wrapper.findComponent({ name: "MainChatHeader" }).text()).toContain(warning);
    expect(wrapper.find(".threadWarningBanner").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows only the lane title without repeating a project prefix in the chat header", () => {
    const wrapper = mount(MainChat, {
      props: {
        title: "Planner",
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: { stubs: { MarkdownContent: true } },
    });

    const title = wrapper.find(".paneTitle");
    expect(title.exists()).toBe(true);
    expect(title.text()).toBe("Planner");
    expect(wrapper.text()).not.toContain("Project:");
    wrapper.unmount();
  });
});
