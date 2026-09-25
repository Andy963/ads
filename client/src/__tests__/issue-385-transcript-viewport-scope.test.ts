import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import MainChat from "../components/MainChat.vue";
import {
  buildTranscriptViewportScopeKey,
  isTranscriptViewportScopeCurrent,
} from "../lib/transcriptViewportScope";

function readUtf8(relativePath: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, relativePath), "utf8");
}

describe("Issue #385 transcript viewport scope", () => {
  it("accepts only the current account, panel, and session scope", () => {
    const current = buildTranscriptViewportScopeKey({ panelKey: "worker:session-a", errorRecoveryGeneration: 0, accountGeneration: 2 });
    const oldSession = buildTranscriptViewportScopeKey({ panelKey: "worker:session-old", errorRecoveryGeneration: 0, accountGeneration: 2 });
    const oldAccount = buildTranscriptViewportScopeKey({ panelKey: "worker:session-a", errorRecoveryGeneration: 0, accountGeneration: 1 });

    expect(isTranscriptViewportScopeCurrent(current, current)).toBe(true);
    expect(isTranscriptViewportScopeCurrent(oldSession, current)).toBe(false);
    expect(isTranscriptViewportScopeCurrent(oldAccount, current)).toBe(false);
  });

  it("emits the scope before the viewport when a keyed chat panel unmounts", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        viewportScopeKey: "worker:session-a:0:2",
      },
      global: { stubs: { MarkdownContent: true } },
    });
    const host = wrapper.get(".chat").element as HTMLElement;
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 240 });
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 240));

    wrapper.unmount();

    expect(wrapper.emitted("update:viewportScope")?.[0]).toEqual(["worker:session-a:0:2"]);
    expect(wrapper.emitted("update:viewport")).toHaveLength(1);
  });

  it("fences viewport events from a panel belonging to an old session scope", () => {
    const app = readUtf8("../App.vue");
    const mainChat = readUtf8("../components/MainChat.vue");

    expect(mainChat).toMatch(/viewportScopeKey\?:\s*string\s*;/);
    expect(mainChat).toMatch(/emit\("update:viewportScope", props\.viewportScopeKey\)/);
    expect(mainChat.indexOf('emit("update:viewportScope"')).toBeLessThan(mainChat.indexOf('emit("update:viewport", viewport)'));
    expect(app).toMatch(/:viewport-scope-key="advisorViewportScopeKey"/);
    expect(app).toMatch(/:viewport-scope-key="workerViewportScopeKey"/);
    expect(app).toMatch(/accountGeneration\.value/);
    expect(app).toMatch(/isTranscriptViewportScopeCurrent\(advisorViewportScope\.value, advisorViewportScopeKey\.value\)/);
    expect(app).toMatch(/isTranscriptViewportScopeCurrent\(workerViewportScope\.value, workerViewportScopeKey\.value\)/);
  });
});
