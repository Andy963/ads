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
    expect(isLaneConnected("tasks", { planner: true, worker: true })).toBe(false);
  });

  it("keeps connected lane text green when the tab is active", () => {
    const css = readAppCss();

    expect(css).toMatch(
      /\.laneTab\.active\.laneTab--connected\s*\{[\s\S]*?color:\s*#059669\s*;/,
    );
  });
});
