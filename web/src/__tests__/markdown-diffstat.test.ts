import { describe, it, expect } from "vitest";

import { renderMarkdownToHtml } from "../lib/markdown";

describe("markdown diffstat", () => {
  it("renders (+A -B) with colored spans", () => {
    const html = renderMarkdownToHtml("- `web/src/app/featureFlags.ts` (+0 -1)");
    expect(html).toContain('class="md-diffstat"');
    expect(html).toContain('class="md-diffstat-add"');
    expect(html).toContain(">+0<");
    expect(html).toContain('class="md-diffstat-del"');
    expect(html).toContain(">-1<");
  });
});

