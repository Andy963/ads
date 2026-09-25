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

  it("resolves every legacy spelling to its canonical lane", () => {
    // Values written before the terminology migration are still in users'
    // localStorage, so reads have to keep resolving them.
    expect(normalizeMobileWorkspaceTab("advisor")).toBe("acopilot");
    expect(normalizeMobileWorkspaceTab("planner")).toBe("acopilot");
    expect(normalizeMobileWorkspaceTab("acopilot")).toBe("acopilot");
    expect(normalizeMobileWorkspaceTab("worker")).toBe("actions");
    expect(normalizeMobileWorkspaceTab("actions")).toBe("actions");
  });

  it("falls back to the Acopilot lane for values that denote no lane", () => {
    expect(normalizeMobileWorkspaceTab("tasks")).toBe("acopilot");
    expect(normalizeMobileWorkspaceTab("invalid")).toBe("acopilot");
    expect(normalizeMobileWorkspaceTab(null)).toBe("acopilot");
    expect(normalizeMobileWorkspaceTab(undefined)).toBe("acopilot");
  });

  it("reads a legacy stored value as its canonical lane", () => {
    localStorage.setItem("ads.mobileWorkspaceTab.p-legacy", "planner");
    expect(readMobileWorkspaceTab("p-legacy")).toBe("acopilot");
  });

  it("lazily migrates the legacy scattered key into the unified project record", () => {
    localStorage.setItem("ads.mobileWorkspaceTab.p1", "worker");
    expect(readMobileWorkspaceTab("p1")).toBe("actions");
    expect(readStoredMobileTab("p1")).toBe("actions");
    expect(localStorage.getItem("ads.mobileWorkspaceTab.p1")).toBeNull();
  });

  it("reads and writes values independently for each project", () => {
    writeMobileWorkspaceTab("p1", "actions");
    writeMobileWorkspaceTab("p2", "acopilot");

    expect(readMobileWorkspaceTab("p1")).toBe("actions");
    expect(readMobileWorkspaceTab("p2")).toBe("acopilot");
    expect(readMobileWorkspaceTab("p3")).toBe("acopilot");
    expect(readStoredMobileTab("p1")).toBe("actions");
    expect(readStoredMobileTab("p2")).toBe("acopilot");
  });

  it("does not create a shared key for an empty project id", () => {
    writeMobileWorkspaceTab("", "actions");
    expect(localStorage.getItem("ads.prefs.unknown")).toBeNull();
    expect(readMobileWorkspaceTab("")).toBe("acopilot");
  });
});
