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
  it("maps the Acopilot and Actions tabs to their independent runtime states", () => {
    const states = { acopilot: true, actions: false };

    expect(isLaneConnected("acopilot", states)).toBe(true);
    expect(isLaneConnected("actions", states)).toBe(false);
  });

  it("does not mark a lane connected when only the other lane is", () => {
    expect(isLaneConnected("acopilot", { acopilot: false, actions: true })).toBe(false);
  });

  it("ignores legacy lane spellings", () => {
    // The tab id is a canonical lane; a legacy spelling is not a lane and must
    // not be reported as connected.
    const states = { acopilot: true, actions: true };
    expect(isLaneConnected("advisor" as never, states)).toBe(false);
    expect(isLaneConnected("worker" as never, states)).toBe(false);
  });

  it("renders connection state with an independent six-pixel status dot", () => {
    const css = readAppCss();

    expect(css).toMatch(/\.laneTabStatusDot\s*\{[\s\S]*?width:\s*7px;[\s\S]*?height:\s*7px;/);
    expect(css).toMatch(/\.laneTabStatusDot--connected\s*\{[\s\S]*?background:\s*#059669\s*;/);
    expect(css).toMatch(/\.laneTabStatusDot--disconnected\s*\{[\s\S]*?background:\s*#94a3b8\s*;/);
    expect(css).not.toMatch(/\.laneTab\.active\.laneTab--connected/);
  });

  it("keeps the active lane tab text high contrast", () => {
    const css = readAppCss();

    expect(css).toMatch(/\.laneTab\.active\s*\{[\s\S]*?color:\s*var\(--text\)\s*;/);
    expect(css).toMatch(/\.laneTab:not\(\.active\)\s*\{[\s\S]*?color:\s*var\(--muted\)\s*;/);
    expect(css).toMatch(/\.laneTab:not\(\.active\):hover\s*\{[\s\S]*?color:\s*var\(--text\)\s*;/);
  });
});
