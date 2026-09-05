import { describe, expect, it, vi } from "vitest";

import { createSyncEventSequencer } from "./syncSequencer";

describe("sync event sequencer", () => {
  it("does not commit buffered live events when catch-up is aborted", () => {
    const writeCursor = vi.fn();
    const applied: number[] = [];
    const sequencer = createSyncEventSequencer({ initialCursor: 0, writeCursor });

    sequencer.beginCatchUp();
    sequencer.observe({ seq: 5 }, () => applied.push(5));
    sequencer.abortCatchUp();

    expect(applied).toEqual([]);
    expect(sequencer.getLastAppliedSeq()).toBe(0);
    expect(writeCursor).not.toHaveBeenCalled();

    sequencer.observe({ seq: 1 }, () => applied.push(1));

   expect(applied).toEqual([1]);
   expect(sequencer.getLastAppliedSeq()).toBe(1);
   expect(writeCursor).toHaveBeenLastCalledWith(1);
 });

  it("buffers unsequenced live events during catch-up and applies them after catch-up completes", () => {
    const writeCursor = vi.fn();
    const applied: string[] = [];
    const sequencer = createSyncEventSequencer({ initialCursor: 0, writeCursor });

    sequencer.beginCatchUp();
    // Live unsequenced event arrives while catch-up is in flight
    sequencer.observe({ type: "live" }, () => applied.push("unsequenced-live"));
    expect(applied).toEqual([]);

    // Sequenced catch-up item arrives
    sequencer.applyCatchUp({ seq: 1 }, () => applied.push("catch-up-1"));
    expect(applied).toEqual(["catch-up-1"]);

    // Catch-up completes
    sequencer.completeCatchUp();
    expect(applied).toEqual(["catch-up-1", "unsequenced-live"]);
  });

  it("drops buffered unsequenced events when catch-up is aborted", () => {
    const writeCursor = vi.fn();
    const applied: string[] = [];
    const sequencer = createSyncEventSequencer({ initialCursor: 0, writeCursor });

    sequencer.beginCatchUp();
    sequencer.observe({ type: "live" }, () => applied.push("unsequenced-live"));
    sequencer.abortCatchUp();

    expect(applied).toEqual([]);
  });
});
