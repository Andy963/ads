import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readUtf8(relativePath: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, relativePath), "utf8");
}

describe("Issue #385 transcript viewport scope", () => {
  it("fences viewport events from a panel belonging to an old session scope", () => {
    const app = readUtf8("../App.vue");
    const mainChat = readUtf8("../components/MainChat.vue");

    expect(mainChat).toMatch(/viewportScopeKey\?:\s*string\s*;/);
    expect(mainChat).toMatch(/emit\("update:viewportScope", props\.viewportScopeKey\)/);
    expect(mainChat.indexOf('emit("update:viewportScope"')).toBeLessThan(mainChat.indexOf('emit("update:viewport", viewport)'));
    expect(app).toMatch(/:viewport-scope-key="advisorViewportScopeKey"/);
    expect(app).toMatch(/:viewport-scope-key="workerViewportScopeKey"/);
    expect(app).toMatch(/if \(advisorViewportScope\.value !== advisorViewportScopeKey\.value\) return;/);
    expect(app).toMatch(/if \(workerViewportScope\.value !== workerViewportScopeKey\.value\) return;/);
  });
});
