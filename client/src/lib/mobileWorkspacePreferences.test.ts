import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeMobileWorkspaceTab,
  readMobileWorkspaceTab,
  writeMobileWorkspaceTab,
} from "./mobileWorkspacePreferences";

function readStoredMobileTab(projectId: string): string | null {
  const raw = localStorage.getItem(`ads.prefs.${projectId}`);
  if (!raw) return null;
  const prefs = JSON.parse(raw) as { mobileTab?: string };
  return prefs.mobileTab ?? null;
}

describe("mobileWorkspacePreferences", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("normalizes invalid values to Advisor", () => {
    expect(normalizeMobileWorkspaceTab("tasks")).toBe("advisor");
    expect(normalizeMobileWorkspaceTab("advisor")).toBe("advisor");
    expect(normalizeMobileWorkspaceTab("acopilot")).toBe("advisor");
    expect(normalizeMobileWorkspaceTab("worker")).toBe("worker");
    expect(normalizeMobileWorkspaceTab("actions")).toBe("worker");
    expect(normalizeMobileWorkspaceTab("invalid")).toBe("advisor");
    expect(normalizeMobileWorkspaceTab(null)).toBe("advisor");
  });

  it("maps the legacy planner value stored before the rename to advisor", () => {
    expect(normalizeMobileWorkspaceTab("planner")).toBe("advisor");
    localStorage.setItem("ads.mobileWorkspaceTab.p-legacy", "planner");
    expect(readMobileWorkspaceTab("p-legacy")).toBe("advisor");
  });

  it("lazily migrates the legacy scattered key into the unified project record", () => {
    localStorage.setItem("ads.mobileWorkspaceTab.p1", "worker");
    expect(readMobileWorkspaceTab("p1")).toBe("worker");
    expect(readStoredMobileTab("p1")).toBe("actions");
    expect(localStorage.getItem("ads.mobileWorkspaceTab.p1")).toBeNull();
  });

  it("reads and writes values independently for each project", () => {
    writeMobileWorkspaceTab("p1", "worker");
    writeMobileWorkspaceTab("p2", "advisor");

    expect(readMobileWorkspaceTab("p1")).toBe("worker");
    expect(readMobileWorkspaceTab("p2")).toBe("advisor");
    expect(readMobileWorkspaceTab("p3")).toBe("advisor");
    expect(readStoredMobileTab("p1")).toBe("actions");
    expect(readStoredMobileTab("p2")).toBe("acopilot");
  });

  it("does not create a shared key for an empty project id", () => {
    writeMobileWorkspaceTab("", "worker");
    expect(localStorage.getItem("ads.prefs.unknown")).toBeNull();
    expect(readMobileWorkspaceTab("")).toBe("advisor");
  });
});
