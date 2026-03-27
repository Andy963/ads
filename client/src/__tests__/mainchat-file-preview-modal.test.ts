import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";
import { readSfc } from "./readSfc";

describe("MainChat file preview modal", () => {
  const originalFetch = globalThis.fetch;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    vi.restoreAllMocks();
  });

  it("opens a file preview modal and highlights the requested line", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          path: "/tmp/ws/app/memory/chunker.py",
          content: "line 45\nline 46\nline 47",
          totalLines: 120,
          startLine: 45,
          endLine: 47,
          truncated: true,
          language: "python",
          line: 46,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          {
            id: "m1",
            role: "assistant",
            kind: "text",
            content: '[chunker](/tmp/ws/app/memory/chunker.py#L46)',
          },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
        workspaceRoot: "/tmp/ws",
      },
      attachTo: document.body,
    });

    await wrapper.find("a").trigger("click");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const fetchUrl = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? "");
    expect(fetchUrl).toContain("/api/files/content?");
    expect(fetchUrl).toContain("workspace=%2Ftmp%2Fws");
    expect(fetchUrl).toContain("line=46");

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="chat-file-preview-modal"]').exists()).toBe(true);
      expect(wrapper.text()).toContain("120 行");
    });
    expect(wrapper.text()).not.toContain("文件预览");
    expect(wrapper.find('[data-line="46"]').classes()).toContain("filePreviewLine--highlight");

    wrapper.unmount();
  });

  it("opens a file preview modal from an inline-code file reference", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          path: "/tmp/ws/app/memory/chunker.py",
          content: "line 45\nline 46\nline 47",
          totalLines: 120,
          startLine: 45,
          endLine: 47,
          truncated: true,
          language: "python",
          line: 46,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          {
            id: "m1",
            role: "assistant",
            kind: "text",
            content: "`/tmp/ws/app/memory/chunker.py#L46`",
          },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
        workspaceRoot: "/tmp/ws",
      },
      attachTo: document.body,
    });

    await wrapper.find("a").trigger("click");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const fetchUrl = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? "");
    expect(fetchUrl).toContain("/api/files/content?");
    expect(fetchUrl).toContain("workspace=%2Ftmp%2Fws");
    expect(fetchUrl).toContain("path=%2Ftmp%2Fws%2Fapp%2Fmemory%2Fchunker.py");
    expect(fetchUrl).toContain("line=46");

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="chat-file-preview-modal"]').exists()).toBe(true);
      expect(wrapper.find('[data-line="46"]').classes()).toContain("filePreviewLine--highlight");
    });

    wrapper.unmount();
  });

  it("closes the file preview modal when the header close button is clicked", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          path: "/tmp/ws/app/memory/chunker.py",
          content: "line 45\nline 46\nline 47",
          totalLines: 120,
          startLine: 45,
          endLine: 47,
          truncated: false,
          language: "python",
          line: 46,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          {
            id: "m1",
            role: "assistant",
            kind: "text",
            content: '[chunker](/tmp/ws/app/memory/chunker.py#L46)',
          },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
        workspaceRoot: "/tmp/ws",
      },
      attachTo: document.body,
    });

    await wrapper.find("a").trigger("click");

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="chat-file-preview-modal"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="chat-file-preview-close"]').exists()).toBe(true);
    });

    await wrapper.find('[data-testid="chat-file-preview-close"]').trigger("click");

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="chat-file-preview-modal"]').exists()).toBe(false);
    });

    wrapper.unmount();
  });

  it("keeps the preview modal on the shared light code surface", async () => {
    const source = await readSfc("../components/ChatFilePreviewModal.vue", import.meta.url);

    expect(source).not.toContain('<div class="filePreviewTitle">文件预览</div>');
    expect(source).toContain("background: var(--github-code-bg);");
    expect(source).toContain("color: var(--github-text);");
  });
});
