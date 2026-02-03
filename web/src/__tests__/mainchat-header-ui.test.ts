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

  it("only shows the green top border while the chat is active", () => {
    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.detail\s*\{[\s\S]*?border-top:\s*2px\s+solid\s+transparent\s*;[\s\S]*?\}/);
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
    expect(withHistory.classes()).toContain("detail--active");
    withHistory.unmount();
  });

  it("renders a green top border on the chat detail container", () => {
    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.detail--active\s*\{[\s\S]*?border-top-color:\s*#22c55e\s*;[\s\S]*?\}/);
  });
});
