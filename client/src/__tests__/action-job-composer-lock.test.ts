import { describe, expect, it } from "vitest";

import { hasLockingActionJob, isActionJobLockingStatus } from "../lib/actionJobs";

describe("actionJobs composer lock", () => {
  it("locks the composer while a job is executing", () => {
    for (const status of ["running", "verifying", "reviewing", "waiting_merge"]) {
      expect(isActionJobLockingStatus(status)).toBe(true);
    }
  });

  it("unlocks the composer for queued, terminal, and human-attention statuses", () => {
    for (const status of ["queued", "completed", "failed", "blocked", "cancelled"]) {
      expect(isActionJobLockingStatus(status)).toBe(false);
    }
  });

  it("ignores unknown or empty statuses", () => {
    expect(isActionJobLockingStatus("")).toBe(false);
    expect(isActionJobLockingStatus("RUNNING")).toBe(false);
  });

  it("locks only when at least one job is in a locking status", () => {
    expect(hasLockingActionJob([])).toBe(false);
    expect(hasLockingActionJob([{ status: "queued" }, { status: "completed" }])).toBe(false);
    expect(hasLockingActionJob([{ status: "queued" }, { status: "running" }])).toBe(true);
    expect(hasLockingActionJob([{ status: "blocked" }, { status: "waiting_merge" }])).toBe(true);
  });
});
