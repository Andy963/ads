import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeWorkspaceTab,
  readWorkspaceTab,
  writeWorkspaceTab,
} from "./workspaceTabPreferences";

function readStoredMobileTab(projectId: string): string | null {
  const raw = localStorage.getItem(`ads.prefs.${projectId}`);
  if (!raw) return null;
  const prefs = JSON.parse(raw) as { mobileTab?: string };
  return prefs.mobileTab ?? null;
}

describe("workspaceTabPreferences", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("resolves every legacy spelling to its canonical lane", () => {
    // Values written before the terminology migration are still in users'
    // localStorage, so reads have to keep resolving them.
    expect(normalizeWorkspaceTab("advisor")).toBe("acopilot");
    expect(normalizeWorkspaceTab("planner")).toBe("acopilot");
    expect(normalizeWorkspaceTab("acopilot")).toBe("acopilot");
    expect(normalizeWorkspaceTab("worker")).toBe("actions");
    expect(normalizeWorkspaceTab("actions")).toBe("actions");
  });

  it("falls back to the Acopilot lane for values that denote no lane", () => {
    expect(normalizeWorkspaceTab("tasks")).toBe("acopilot");
    expect(normalizeWorkspaceTab("invalid")).toBe("acopilot");
    expect(normalizeWorkspaceTab(null)).toBe("acopilot");
    expect(normalizeWorkspaceTab(undefined)).toBe("acopilot");
  });

  it("reads a legacy stored value as its canonical lane", () => {
    localStorage.setItem("ads.mobileWorkspaceTab.p-legacy", "planner");
    expect(readWorkspaceTab("p-legacy")).toBe("acopilot");
  });

  it("lazily migrates the legacy scattered key into the unified project record", () => {
    localStorage.setItem("ads.mobileWorkspaceTab.p1", "worker");
    expect(readWorkspaceTab("p1")).toBe("actions");
    expect(readStoredMobileTab("p1")).toBe("actions");
    expect(localStorage.getItem("ads.mobileWorkspaceTab.p1")).toBeNull();
  });

  it("reads and writes values independently for each project", () => {
    writeWorkspaceTab("p1", "actions");
    writeWorkspaceTab("p2", "acopilot");

    expect(readWorkspaceTab("p1")).toBe("actions");
    expect(readWorkspaceTab("p2")).toBe("acopilot");
    expect(readWorkspaceTab("p3")).toBe("acopilot");
    expect(readStoredMobileTab("p1")).toBe("actions");
    expect(readStoredMobileTab("p2")).toBe("acopilot");
  });

  it("does not create a shared key for an empty project id", () => {
    writeWorkspaceTab("", "actions");
    expect(localStorage.getItem("ads.prefs.unknown")).toBeNull();
    expect(readWorkspaceTab("")).toBe("acopilot");
  });
});
