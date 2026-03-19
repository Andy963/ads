import { describe, it, expect } from "vitest";
import { readSfc } from "./readSfc";

describe("live-step scrollbar styling", () => {
  it("does not use an in-place scrollbar for the live-step reasoning pane (fold/expand instead)", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    const selector = '.msg[data-id="live-step"] .liveStepBody :deep(.md)';
    expect(css).toContain(selector);
    expect(css).toContain(`${selector} {`);

    expect(css).toContain("overflow: hidden;");
    expect(css).toContain("max-height: 3lh;");

    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    const end = css.indexOf("}", start);
    const block = css.slice(start, end);
    expect(block).not.toMatch(/scrollbar-/);
    expect(block).not.toMatch(/overflow-y:\s*auto\s*;/);

    // Ensure we didn't regress back to a per-live-step scrollbar styling hook.
    expect(css).not.toContain(`${selector}::-webkit-scrollbar`);
  });
});
