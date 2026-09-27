import { describe, expect, it } from "vitest";

import { formatBlockedDuration } from "../lib/actionJobs";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

describe("formatBlockedDuration", () => {
  it("renders minute, hour, and day granularity", () => {
    expect(formatBlockedDuration(NOW - 30_000, NOW)).toBe("just now");
    expect(formatBlockedDuration(NOW - 59 * MINUTE, NOW)).toBe("59m");
    expect(formatBlockedDuration(NOW - 60 * MINUTE, NOW)).toBe("1h");
    expect(formatBlockedDuration(NOW - 150 * MINUTE, NOW)).toBe("2h 30m");
    expect(formatBlockedDuration(NOW - 24 * 60 * MINUTE, NOW)).toBe("1d");
    expect(formatBlockedDuration(NOW - 50 * 60 * MINUTE, NOW)).toBe("2d 2h");
  });

  it("falls back to updated_at and clamps unusable input", () => {
    expect(formatBlockedDuration(null, NOW, NOW - 10 * MINUTE)).toBe("10m");
    expect(formatBlockedDuration(undefined, NOW, NOW - 3 * 60 * MINUTE)).toBe("3h");
    expect(formatBlockedDuration(null, NOW)).toBeNull();
    expect(formatBlockedDuration(undefined, NOW)).toBeNull();
    expect(formatBlockedDuration(Number.NaN, NOW, null)).toBeNull();
    expect(formatBlockedDuration(NOW + MINUTE, NOW)).toBe("just now");
  });
});
