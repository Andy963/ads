import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveFromHere(relativePath: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, relativePath);
}

describe("live-step scrollbar styling", () => {
  it("does not use an in-place scrollbar for the live-step reasoning pane (fold/expand instead)", async () => {
    const cssPath = resolveFromHere("../components/MainChat.css");
    const css = await readFile(cssPath, "utf8");

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
