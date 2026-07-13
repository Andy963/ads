import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AsyncLock } from "../../server/utils/asyncLock.js";

describe("AsyncLock", () => {
  it("cancels a queued acquisition without blocking later work", async () => {
    const lock = new AsyncLock();
    let releaseFirst!: () => void;
    const first = lock.runExclusive(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    while (!releaseFirst) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const controller = new AbortController();
    let canceledRan = false;
    const canceled = lock.runExclusive(async () => {
      canceledRan = true;
    }, controller.signal);
    const third = lock.runExclusive(async () => "done");

    controller.abort();
    await assert.rejects(canceled, (error: unknown) => {
      return error instanceof Error && error.name === "AbortError";
    });

    releaseFirst();
    await first;
    assert.equal(await third, "done");
    assert.equal(canceledRan, false);
    assert.equal(lock.isBusy(), false);
  });
});
