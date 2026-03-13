import { describe, expect, it } from "vitest";

import {
  buildModelIdStorageKey,
  buildReasoningEffortStorageKey,
  normalizeModelId,
  normalizeReasoningEffort,
} from "./chatPreferences";

describe("chatPreferences", () => {
  it("normalizes reasoning effort values for persistence and restore", () => {
    expect(normalizeReasoningEffort(" medium ")).toBe("medium");
    expect(normalizeReasoningEffort("xhigh")).toBe("xhigh");
    expect(normalizeReasoningEffort("low")).toBe("medium");
    expect(normalizeReasoningEffort("")).toBe("high");
    expect(normalizeReasoningEffort("unknown")).toBe("high");
  });

  it("normalizes model ids with auto fallback", () => {
    expect(normalizeModelId(" gpt-5 ")).toBe("gpt-5");
    expect(normalizeModelId("")).toBe("auto");
    expect(normalizeModelId(null)).toBe("auto");
  });

  it("builds stable localStorage keys with trimmed fallback segments", () => {
    expect(buildReasoningEffortStorageKey(" default ", " main ")).toBe("ads.reasoningEffort.default.main");
    expect(buildReasoningEffortStorageKey("", "")).toBe("ads.reasoningEffort.unknown.main");
    expect(buildModelIdStorageKey(" session-1 ", " planner ")).toBe("ads.modelId.session-1.planner");
    expect(buildModelIdStorageKey("", "")).toBe("ads.modelId.unknown.main");
  });
});
