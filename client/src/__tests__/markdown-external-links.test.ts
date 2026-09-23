import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import MarkdownContent from "../components/MarkdownContent.vue";
import { renderMarkdownToHtml } from "../lib/markdown";

describe("markdown external links", () => {
  describe("renderer target attributes", () => {
    it("renders external http/https links with _blank and noreferrer noopener", () => {
      const html = renderMarkdownToHtml("[docs](https://example.com/docs) and [legacy](http://example.com)");
      expect(html).toContain('href="https://example.com/docs"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noreferrer noopener"');
    });

    it("renders autolinkified external urls with _blank and noreferrer noopener", () => {
      const html = renderMarkdownToHtml("see https://github.com/Andy963/ads/issues/262");
      expect(html).toContain('href="https://github.com/Andy963/ads/issues/262"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noreferrer noopener"');
    });

    it("does not add _blank to in-page hash anchors", () => {
      const html = renderMarkdownToHtml("[section](#some-section)");
      expect(html).toContain('href="#some-section"');
      expect(html).not.toContain('target="_blank"');
      expect(html).not.toContain('rel="noreferrer noopener"');
    });
  });

  describe("MarkdownContent click delegation", () => {
    const originalOpen = window.open;

    afterEach(() => {
      window.open = originalOpen;
      vi.restoreAllMocks();
    });

    it("opens external links via window.open instead of in-place navigation", async () => {
      const openSpy = vi.fn().mockReturnValue(null);
      window.open = openSpy as typeof window.open;

      const wrapper = mount(MarkdownContent, {
        props: { content: "[docs](https://example.com/docs)" },
      });

      const anchor = wrapper.find("a");
      expect(anchor.attributes("target")).toBe("_blank");
      await anchor.trigger("click");

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
    });

    it("leaves modified clicks (ctrl/cmd/shift) to the browser", async () => {
      const openSpy = vi.fn().mockReturnValue(null);
      window.open = openSpy as typeof window.open;

      const wrapper = mount(MarkdownContent, {
        props: { content: "[docs](https://example.com/docs)" },
      });

      await wrapper.find("a").trigger("click", { ctrlKey: true });
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("prevents navigation for relative or local file links to protect SPA window", async () => {
      const openSpy = vi.fn().mockReturnValue(null);
      window.open = openSpy as typeof window.open;

      const wrapper = mount(MarkdownContent, {
        props: {
          content: "[chunker](/tmp/ws/app/memory/chunker.py#L46)",
        },
      });

      const event = new MouseEvent("click", { cancelable: true, bubbles: true });
      wrapper.find("a").element.dispatchEvent(event);

      expect(openSpy).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    });
  });
});
