import { describe, expect, it } from "vitest";

import {
  normalizeModelId,
  normalizeReasoningEffort,
} from "./chatPreferences";

describe("chatPreferences", () => {
  it("normalizes reasoning effort values for persistence and restore", () => {
    expect(normalizeReasoningEffort(" medium ")).toBe("medium");
    expect(normalizeReasoningEffort("xhigh")).toBe("high");
    expect(normalizeReasoningEffort("max")).toBe("high");
    expect(normalizeReasoningEffort("ultra")).toBe("high");
    expect(normalizeReasoningEffort("low")).toBe("low");
    expect(normalizeReasoningEffort("")).toBe("high");
    expect(normalizeReasoningEffort("unknown")).toBe("high");
  });

  it("normalizes model ids with auto fallback", () => {
    expect(normalizeModelId(" gpt-5 ")).toBe("gpt-5");
    expect(normalizeModelId("")).toBe("auto");
    expect(normalizeModelId(null)).toBe("auto");
  });
});
