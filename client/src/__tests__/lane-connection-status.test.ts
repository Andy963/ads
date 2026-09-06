import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isLaneConnected } from "../lib/laneConnectionStatus";

function readAppCss(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, "../App.css"), "utf8");
}

describe("lane connection status", () => {
  it("maps the Advisor and Worker tabs to their independent runtime states", () => {
    const states = { planner: true, worker: false };

    expect(isLaneConnected("planner", states)).toBe(true);
    expect(isLaneConnected("worker", states)).toBe(false);
  });

  it("does not mark the Task tab as connected", () => {
    expect(isLaneConnected("planner", { planner: false, worker: true })).toBe(false);
  });

  it("renders connection state with an independent six-pixel status dot", () => {
    const css = readAppCss();

    expect(css).toMatch(/\.laneTabStatusDot\s*\{[\s\S]*?width:\s*6px;[\s\S]*?height:\s*6px;/);
    expect(css).toMatch(/\.laneTabStatusDot--connected\s*\{[\s\S]*?background:\s*#059669\s*;/);
    expect(css).toMatch(/\.laneTabStatusDot--disconnected\s*\{[\s\S]*?background:\s*#94a3b8\s*;/);
    expect(css).not.toMatch(/\.laneTab\.active\.laneTab--connected/);
  });

  it("keeps the active lane tab text high contrast", () => {
    const css = readAppCss();

    expect(css).toMatch(/\.laneTab\.active\s*\{[\s\S]*?color:\s*#0f172a\s*;/);
    expect(css).toMatch(/\.laneTab:not\(\.active\)\s*\{[\s\S]*?color:\s*#64748b\s*;/);
    expect(css).toMatch(/\.laneTab:not\(\.active\):hover\s*\{[\s\S]*?color:\s*#334155\s*;/);
  });
});
