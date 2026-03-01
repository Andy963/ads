import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveFromHere(relativePath: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, relativePath);
}

describe("planner scrollbar styling", () => {
  it("uses a thinner scrollbar for the planner chat list", async () => {
    const cssPath = resolveFromHere("../components/MainChat.css");
    const css = await readFile(cssPath, "utf8");

    const selector = ".chatHost--planner .chat";
    expect(css).toContain(selector);
    expect(css).toContain(`${selector} {`);

    // Firefox
    expect(css).toContain("scrollbar-width: thin;");

    // Chromium/WebKit
    expect(css).toContain(`${selector}::-webkit-scrollbar {`);
    expect(css).toContain("width: 6px;");
  });
});

