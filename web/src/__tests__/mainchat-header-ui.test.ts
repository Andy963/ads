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

  it("renders a green top border on the chat detail container", () => {
    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.detail\s*\{[\s\S]*?border-top:\s*2px\s+solid\s+#22c55e\s*;[\s\S]*?\}/);
  });
});
