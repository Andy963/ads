import { describe, expect, it } from "vitest";

import { renderMarkdownToHtml } from "../lib/markdown";
import { readSfc } from "./readSfc";

describe("markdown GitHub theme regression", () => {
  it("renders fenced code blocks with highlight classes", () => {
    const html = renderMarkdownToHtml("```ts\nconst answer: number = 1;\n```");

    expect(html).toContain('class="md-codeblock"');
    expect(html).toContain('class="hljs language-typescript"');
    expect(html).toContain("hljs-keyword");
  });

  it("renders common markdown structures used by the chat UI", () => {
    const html = renderMarkdownToHtml("> quote\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---");

    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain("<hr>");
  });

  it("keeps GitHub-like markdown styles for code and rich content", async () => {
    const css = await readSfc("../components/MarkdownContent.vue", import.meta.url);

    expect(css).toMatch(/\.md\s*:deep\(blockquote\)\s*\{[\s\S]*?border-left:\s*4px solid var\(--github-border-muted\)\s*;/);
    expect(css).toMatch(/\.md\s*:deep\(table\)\s*\{[\s\S]*?overflow-x:\s*auto\s*;/);
    expect(css).toMatch(/\.md\s*:deep\(\.hljs-keyword\)[\s\S]*?color:\s*#cf222e\s*;/);
    expect(css).toMatch(/\.md\s*:deep\(\.md-codeblock\)\s*\{[\s\S]*?background:\s*var\(--github-code-bg\)\s*;/);
  });
});
