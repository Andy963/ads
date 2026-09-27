import { describe, expect, it } from "vitest";

import { formatBlockedDuration } from "../lib/actionJobs";

const NOW = 1_700_000_000_000;

describe("formatBlockedDuration", () => {
  it("renders minute, hour, and day granularity", () => {
    expect(formatBlockedDuration(NOW - 30_000, NOW)).toBe("just now");
    expect(formatBlockedDuration(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(formatBlockedDuration(NOW - 59 * 60_000, NOW)).toBe("59m");
    expect(formatBlockedDuration(NOW - 60 * 60_000, NOW)).toBe("1h");
    expect(formatBlockedDuration(NOW - 150 * 60_000, NOW)).toBe("2h 30m");
    expect(formatBlockedDuration(NOW - 24 * 3_600_000, NOW)).toBe("1d");
    expect(formatBlockedDuration(NOW - 50 * 3_600_000, NOW)).toBe("2d 2h");
  });

  it("falls back to updated_at when blocked_at is missing", () => {
    expect(formatBlockedDuration(null, NOW, NOW - 10 * 60_000)).toBe("10m");
    expect(formatBlockedDuration(undefined, NOW, NOW - 3 * 3_600_000)).toBe("3h");
  });

  it("returns null when no timestamp is available", () => {
    expect(formatBlockedDuration(null, NOW)).toBeNull();
    expect(formatBlockedDuration(undefined, NOW)).toBeNull();
    expect(formatBlockedDuration(Number.NaN, NOW, null)).toBeNull();
  });

  it("never reports a negative duration when clocks disagree", () => {
    expect(formatBlockedDuration(NOW + 60_000, NOW)).toBe("just now");
  });
});
