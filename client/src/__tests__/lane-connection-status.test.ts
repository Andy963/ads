import { describe, expect, it } from "vitest";

import { isLaneConnected } from "../lib/laneConnectionStatus";

describe("lane connection status", () => {
  it("maps the Advisor and Worker tabs to their independent runtime states", () => {
    const states = { planner: true, worker: false };

    expect(isLaneConnected("planner", states)).toBe(true);
    expect(isLaneConnected("worker", states)).toBe(false);
  });

  it("does not mark the Task tab as connected", () => {
    expect(isLaneConnected("tasks", { planner: true, worker: true })).toBe(false);
  });
});
