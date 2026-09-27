import { describe, expect, it } from "vitest";

import { parseActionJobAttempts } from "../lib/actionJobs";

describe("action job attempt history", () => {
  it("keeps every recorded attempt in order", () => {
    const attempts = parseActionJobAttempts(JSON.stringify([
      { attempt: 1, stage: "Developer execution", failure: "Developer execution failed: boom", ts: 1 },
      { attempt: 2, stage: "Reviewer rejection", failure: "Reviewer rejection failed: defect", ts: 2 },
    ]));

    expect(attempts).toHaveLength(2);
    expect(attempts.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(attempts[1]?.stage).toBe("Reviewer rejection");
  });

  it("returns an empty list for missing, malformed, or non-array payloads", () => {
    expect(parseActionJobAttempts(undefined)).toEqual([]);
    expect(parseActionJobAttempts(null)).toEqual([]);
    expect(parseActionJobAttempts("not-json")).toEqual([]);
    expect(parseActionJobAttempts("{}")).toEqual([]);
  });

  it("drops entries that are missing required fields", () => {
    const attempts = parseActionJobAttempts(JSON.stringify([
      { attempt: 1, stage: "Developer execution", failure: "boom", ts: 1 },
      { attempt: "2", stage: "Reviewer rejection", failure: "defect", ts: 2 },
      { stage: "Verification", failure: "tests failed", ts: 3 },
      null,
    ]));

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attempt).toBe(1);
  });
});
