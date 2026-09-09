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
  it("blends mobile navigation into the chat background without horizontal separators", () => {
    const css = readUtf8("../App.css");
    const mobileCss = css.slice(css.indexOf("@media (max-width: 900px)"));
    const navigation = mobileCss.match(/\.topbar,\s*\.laneTabs\s*\{[^}]*\}/)?.[0];

    expect(navigation).toBeDefined();
    expect(navigation).toMatch(/border-bottom:\s*0\s*;/);
    expect(navigation).toMatch(/box-shadow:\s*none\s*;/);
    expect(navigation).toMatch(/background:\s*var\(--app-bg\)\s*;/);
  });

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

  it("keeps the chat detail container flat while busy state remains in the composer", () => {
    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.detail\s*\{[\s\S]*?position:\s*relative\s*;[\s\S]*?\}/);
    expect(css).not.toContain("detail--active");
    expect(css).not.toMatch(/\.detail\s*\{[\s\S]*?box-shadow\s*:/);
    expect(css).not.toMatch(/\.detail\s*\{[\s\S]*?linear-gradient/);

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
    expect(busy.classes()).not.toContain("detail--active");
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

  it("uses natural compact padding in the chat stream without a large bottom dead void", () => {
    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.chat\s*\{[\s\S]*?padding:\s*12px 16px\s*;/);
    expect(css).not.toContain("220px");
    expect(css).not.toContain("100px");
  });

  it("renders thread warnings inside the chat pane", () => {
    const warning = "上下文线程已重置（预期=thread-old，实际=thread-new）。";
    const wrapper = mount(MainChat, {
      props: {
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
    expect(wrapper.find(".threadWarningBanner").exists()).toBe(true);
    wrapper.unmount();
  });

  it("does not render redundant .paneHeader row in MainChat", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: { stubs: { MarkdownContent: true } },
    });

    expect(wrapper.find(".paneHeader").exists()).toBe(false);
    expect(wrapper.find(".paneTitle").exists()).toBe(false);
    wrapper.unmount();
  });
});
