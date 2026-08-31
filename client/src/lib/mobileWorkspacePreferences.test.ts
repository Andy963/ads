import { afterEach, describe, expect, it } from "vitest";

import {
  buildMobileWorkspaceTabStorageKey,
  normalizeMobileWorkspaceTab,
  readMobileWorkspaceTab,
  writeMobileWorkspaceTab,
} from "./mobileWorkspacePreferences";

describe("mobileWorkspacePreferences", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("builds project-scoped keys and defaults empty project ids safely", () => {
    expect(buildMobileWorkspaceTabStorageKey(" p1 ")).toBe("ads.mobileWorkspaceTab.p1");
    expect(buildMobileWorkspaceTabStorageKey("")).toBe("ads.mobileWorkspaceTab.unknown");
  });

  it("normalizes invalid values to Advisor", () => {
    expect(normalizeMobileWorkspaceTab("tasks")).toBe("tasks");
    expect(normalizeMobileWorkspaceTab("planner")).toBe("planner");
    expect(normalizeMobileWorkspaceTab("worker")).toBe("worker");
    expect(normalizeMobileWorkspaceTab("invalid")).toBe("planner");
    expect(normalizeMobileWorkspaceTab(null)).toBe("planner");
  });

  it("reads and writes values independently for each project", () => {
    writeMobileWorkspaceTab("p1", "worker");
    writeMobileWorkspaceTab("p2", "tasks");

    expect(readMobileWorkspaceTab("p1")).toBe("worker");
    expect(readMobileWorkspaceTab("p2")).toBe("tasks");
    expect(readMobileWorkspaceTab("p3")).toBe("planner");
  });

  it("does not create a shared key for an empty project id", () => {
    writeMobileWorkspaceTab("", "worker");
    expect(localStorage.getItem("ads.mobileWorkspaceTab.unknown")).toBeNull();
    expect(readMobileWorkspaceTab("")).toBe("planner");
  });
});
