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
    expect(normalizeMobileWorkspaceTab("tasks")).toBe("advisor");
    expect(normalizeMobileWorkspaceTab("advisor")).toBe("advisor");
    expect(normalizeMobileWorkspaceTab("worker")).toBe("worker");
    expect(normalizeMobileWorkspaceTab("invalid")).toBe("advisor");
    expect(normalizeMobileWorkspaceTab(null)).toBe("advisor");
  });

  it("maps the legacy planner value stored before the rename to advisor", () => {
    expect(normalizeMobileWorkspaceTab("planner")).toBe("advisor");
    localStorage.setItem("ads.mobileWorkspaceTab.p-legacy", "planner");
    expect(readMobileWorkspaceTab("p-legacy")).toBe("advisor");
  });

  it("reads and writes values independently for each project", () => {
    writeMobileWorkspaceTab("p1", "worker");
    writeMobileWorkspaceTab("p2", "advisor");

    expect(readMobileWorkspaceTab("p1")).toBe("worker");
    expect(readMobileWorkspaceTab("p2")).toBe("advisor");
    expect(readMobileWorkspaceTab("p3")).toBe("advisor");
  });

  it("does not create a shared key for an empty project id", () => {
    writeMobileWorkspaceTab("", "worker");
    expect(localStorage.getItem("ads.mobileWorkspaceTab.unknown")).toBeNull();
    expect(readMobileWorkspaceTab("")).toBe("advisor");
  });
});
