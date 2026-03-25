import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";

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
      expect(wrapper.text()).toContain("共 120 行");
    });
    expect(wrapper.find('[data-line="46"]').classes()).toContain("filePreviewLine--highlight");

    wrapper.unmount();
  });
});
