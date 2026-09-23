import { afterEach, describe, expect, it } from "vitest";

import {
  APP_STATE_STORAGE_KEY,
  buildProjectPreferencesStorageKey,
  eagerMigratePreferencesToV2,
  readAppNavigationState,
  readLaneGenerationPreference,
  readLatestPromptPreference,
  readModelIdPreference,
  readMobileTabPreference,
  readProjectPreferences,
  readReasoningEffortPreference,
  removeProjectPreferences,
  renameProjectPreferences,
  purgeLatestPromptPreferences,
  writeAppNavigationState,
  writeLaneGenerationPreference,
  writeLatestPromptPreference,
  writeModelPreference,
  writeMobileTabPreference,
  writeProjectPreferences,
} from "./preferencesStore";
import { normalizeReasoningEffort } from "./chatPreferences";

function storedRaw(projectId: string): string | null {
  return localStorage.getItem(buildProjectPreferencesStorageKey(projectId));
}

describe("preferencesStore", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("builds exactly one project-scoped storage key", () => {
    expect(buildProjectPreferencesStorageKey("session-1")).toBe("ads.prefs.session-1");
    expect(buildProjectPreferencesStorageKey(" default ")).toBe("ads.prefs.default");
    expect(buildProjectPreferencesStorageKey("")).toBe("ads.prefs.unknown");
  });

  it("persists model id and reasoning effort per lane and agent in one JSON record", () => {
    writeModelPreference("p1", "advisor", "codex", { modelId: "gpt-5.5", effort: "high" });
    writeModelPreference("p1", "advisor", "claude", { modelId: "claude-3-7-sonnet" });
    writeModelPreference("p1", "main", "", { modelId: "gpt-4.1", effort: "medium" });

    expect(readModelIdPreference("p1", "advisor", "codex")).toBe("gpt-5.5");
    expect(readReasoningEffortPreference("p1", "advisor", "codex")).toBe("high");
    expect(readModelIdPreference("p1", "advisor", "claude")).toBe("claude-3-7-sonnet");
    expect(readReasoningEffortPreference("p1", "advisor", "claude")).toBeNull();
    // Lane-wide entries (no agent) live alongside agent-scoped ones.
    expect(readModelIdPreference("p1", "main")).toBe("gpt-4.1");
    expect(readModelIdPreference("p1", "main", "codex")).toBeNull();
    expect(readReasoningEffortPreference("p1", "main")).toBe("medium");

    const keys = Object.keys(localStorage).filter((key) => key.startsWith("ads.prefs."));
    expect(keys).toEqual(["ads.prefs.p1"]);
    const record = JSON.parse(storedRaw("p1")!) as { version: number; models: Record<string, unknown> };
    expect(record.version).toBe(2);
    expect(Object.keys(record.models).sort()).toEqual(["acopilot", "main"]);

    // Updating one agent must not disturb the others.
    writeModelPreference("p1", "advisor", "codex", { effort: "low" });
    expect(readReasoningEffortPreference("p1", "advisor", "codex")).toBe("low");
    expect(readModelIdPreference("p1", "advisor", "codex")).toBe("gpt-5.5");
    expect(readModelIdPreference("p1", "advisor", "claude")).toBe("claude-3-7-sonnet");
  });

  it("writes a model selection under the [lane][agentId] key without touching the lane default", () => {
    writeModelPreference("p1", "advisor", "codex", { modelId: "gpt-5.5" });

    const record = JSON.parse(storedRaw("p1")!) as {
      models: Record<string, Record<string, { modelId?: string }>>;
    };
    expect(record.models.acopilot?.codex?.modelId).toBe("gpt-5.5");
    expect(record.models.acopilot?.default).toBeUndefined();

    // Reads scoped to the same lane+agent find it; other scopes stay empty.
    expect(readModelIdPreference("p1", "advisor", "codex")).toBe("gpt-5.5");
    expect(readModelIdPreference("p1", "acopilot", "codex")).toBe("gpt-5.5");
    expect(readModelIdPreference("p1", "advisor")).toBeNull();
    expect(readModelIdPreference("p1", "advisor", "claude")).toBeNull();
  });

  it("normalizes invalid persisted reasoning efforts to high on read", () => {
    writeModelPreference("p1", "main", "", { modelId: "gpt-4.1", effort: "max" });
    writeModelPreference("p1", "advisor", "codex", { modelId: "gpt-5.5", effort: "ultra" });
    writeModelPreference("p1", "worker", "codex", { modelId: "gpt-5.5", effort: "bogus" });

    expect(normalizeReasoningEffort(readReasoningEffortPreference("p1", "main"))).toBe("max");
    expect(normalizeReasoningEffort(readReasoningEffortPreference("p1", "advisor", "codex"))).toBe("ultra");
    expect(normalizeReasoningEffort(readReasoningEffortPreference("p1", "worker", "codex"))).toBe("high");
  });

  it("migrates legacy scattered keys into the unified record and deletes them", () => {
    localStorage.setItem("ads.modelId.s1.advisor.codex", "gpt-5.5");
    localStorage.setItem("ads.reasoningEffort.s1.advisor.codex", "high");
    localStorage.setItem("ads.modelId.s1.main", "gpt-4o");
    localStorage.setItem("ads.mobileWorkspaceTab.s1", "worker");
    localStorage.setItem("ADS_WEB_LATEST_PROMPT:s1:advisor", "previous prompt");
    localStorage.setItem("ads.laneGeneration.s1.main", "3");
    // Keys belonging to other projects must stay untouched.
    localStorage.setItem("ads.modelId.s2.advisor", "other-model");

    expect(readModelIdPreference("s1", "advisor", "codex")).toBe("gpt-5.5");
    expect(readReasoningEffortPreference("s1", "advisor", "codex")).toBe("high");
    expect(readModelIdPreference("s1", "main")).toBe("gpt-4o");
    expect(readMobileTabPreference("s1")).toBe("actions");
    expect(readLatestPromptPreference("s1", "advisor")).toBe("previous prompt");
    expect(readLaneGenerationPreference("s1", "main")).toBe(3);

    for (const key of [
      "ads.modelId.s1.advisor.codex",
      "ads.reasoningEffort.s1.advisor.codex",
      "ads.modelId.s1.main",
      "ads.mobileWorkspaceTab.s1",
      "ADS_WEB_LATEST_PROMPT:s1:advisor",
      "ads.laneGeneration.s1.main",
    ]) {
      expect(localStorage.getItem(key)).toBeNull();
    }
    expect(localStorage.getItem("ads.modelId.s2.advisor")).toBe("other-model");
    expect(storedRaw("s1")).toBeTruthy();
  });

  it("prefers the canonical advisor lane over the legacy planner variant", () => {
    localStorage.setItem("ads.modelId.s1.planner", "gpt-old");
    localStorage.setItem("ads.modelId.s1.advisor", "gpt-new");
    localStorage.setItem("ads.mobileWorkspaceTab.s1", "worker");

    expect(readModelIdPreference("s1", "advisor")).toBe("gpt-new");
    const prefs = readProjectPreferences("s1");
    expect(prefs.models?.planner).toBeUndefined();
    expect(prefs.models?.acopilot?.default?.modelId).toBe("gpt-new");
    expect(localStorage.getItem("ads.modelId.s1.planner")).toBeNull();
  });

  it("falls back to the legacy planner lane when the advisor key has no value", () => {
    localStorage.setItem("ads.modelId.s1.planner", "gpt-legacy");
    localStorage.setItem("ads.reasoningEffort.s1.planner", "low");
    expect(readModelIdPreference("s1", "advisor")).toBe("gpt-legacy");
    expect(readReasoningEffortPreference("s1", "advisor")).toBe("low");
  });

  it("round-trips latest prompts per lane and ignores empty writes", () => {
    writeLatestPromptPreference("p1", "worker", "  worker prompt  ");
    writeLatestPromptPreference("p1", "advisor", "advisor prompt");
    expect(readLatestPromptPreference("p1", "worker")).toBe("worker prompt");
    expect(readLatestPromptPreference("p1", "advisor")).toBe("advisor prompt");
    expect(readLatestPromptPreference("p1", "main")).toBeNull();

    writeLatestPromptPreference("p1", "worker", "");
    expect(readLatestPromptPreference("p1", "worker")).toBe("worker prompt");
  });

  it("round-trips lane generations with clamping", () => {
    writeLaneGenerationPreference("p1", "main", 2.9);
    expect(readLaneGenerationPreference("p1", "main")).toBe(2);
    writeLaneGenerationPreference("p1", "advisor", 0);
    expect(readLaneGenerationPreference("p1", "advisor")).toBe(1);
    expect(readLaneGenerationPreference("p1", "missing")).toBeNull();
  });

  it("reads and writes the mobile tab", () => {
    writeMobileTabPreference("p1", "worker");
    expect(readMobileTabPreference("p1")).toBe("actions");
    expect(readMobileTabPreference("p2")).toBeNull();
  });

  it("survives malformed stored records by re-migrating legacy keys", () => {
    localStorage.setItem("ads.prefs.s1", "{not json");
    localStorage.setItem("ads.modelId.s1.main", "gpt-4o");
    expect(readModelIdPreference("s1", "main")).toBe("gpt-4o");
    expect(localStorage.getItem("ads.modelId.s1.main")).toBeNull();
  });

  it("removeProjectPreferences deletes the unified record and any legacy orphans", () => {
    writeModelPreference("p1", "main", "", { modelId: "gpt-4o" });
    // Legacy keys that were never migrated (project deleted before any read).
    localStorage.setItem("ads.modelId.p1.advisor", "zombie");
    localStorage.setItem("ads.reasoningEffort.p1.advisor", "zombie");
    localStorage.setItem("ads.mobileWorkspaceTab.p1", "worker");
    localStorage.setItem("ADS_WEB_LATEST_PROMPT:p1:advisor", "zombie");
    localStorage.setItem("ads.laneGeneration.p1.advisor", "7");
    localStorage.setItem("ads.prefs.p2", JSON.stringify({ version: 1, updatedAt: 1, mobileTab: "worker" }));

    removeProjectPreferences("p1");

    expect(storedRaw("p1")).toBeNull();
    expect(localStorage.getItem("ads.modelId.p1.advisor")).toBeNull();
    expect(localStorage.getItem("ads.reasoningEffort.p1.advisor")).toBeNull();
    expect(localStorage.getItem("ads.mobileWorkspaceTab.p1")).toBeNull();
    expect(localStorage.getItem("ADS_WEB_LATEST_PROMPT:p1:advisor")).toBeNull();
    expect(localStorage.getItem("ads.laneGeneration.p1.advisor")).toBeNull();
    expect(storedRaw("p2")).toBeTruthy();
  });

  it("renameProjectPreferences carries preferences across an identity rewrite", () => {
    writeModelPreference("default", "main", "", { modelId: "gpt-4o" });
    writeMobileTabPreference("default", "worker");
    writeModelPreference("sess-x", "main", "", { modelId: "gpt-5" });

    renameProjectPreferences("default", "sess-x");

    expect(readModelIdPreference("sess-x", "main")).toBe("gpt-5");
    expect(readMobileTabPreference("sess-x")).toBe("actions");
    expect(storedRaw("default")).toBeNull();
    expect(localStorage.getItem("ads.modelId.default.main")).toBeNull();
  });

  it("purgeLatestPromptPreferences strips recalled prompts but keeps model preferences", () => {
    writeLatestPromptPreference("p1", "advisor", "private prompt");
    writeModelPreference("p1", "advisor", "codex", { modelId: "gpt-5.5" });
    writeMobileTabPreference("p2", "worker");
    writeLatestPromptPreference("p2", "worker", "other prompt");
    localStorage.setItem("ADS_WEB_LATEST_PROMPT:p3:advisor", "legacy prompt");

    purgeLatestPromptPreferences();

    const p1 = JSON.parse(storedRaw("p1")!) as { latestPrompts?: unknown; models?: unknown };
    expect(p1.latestPrompts).toBeUndefined();
    expect(p1.models).toBeTruthy();
    const p2 = JSON.parse(storedRaw("p2")!) as { latestPrompts?: unknown; mobileTab?: string };
    expect(p2.latestPrompts).toBeUndefined();
    expect(p2.mobileTab).toBe("actions");
    expect(localStorage.getItem("ADS_WEB_LATEST_PROMPT:p3:advisor")).toBeNull();
  });

  it("drops records that only contained prompts during a purge", () => {
    writeLatestPromptPreference("p1", "advisor", "private prompt");
    purgeLatestPromptPreferences();
    expect(storedRaw("p1")).toBeNull();
  });

  describe("app navigation state", () => {
    it("migrates the legacy scattered keys into ads.app_state and deletes them", () => {
      localStorage.setItem("ADS_WEB_PROJECTS", JSON.stringify([{ id: "p1", sessionId: "p1" }]));
      localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "p1");
      localStorage.setItem("ADS_WEB_LAST_REAL_PROJECT", "p1");
      localStorage.setItem("ADS_WEB_LAST_REAL_PROJECT_TAB", JSON.stringify({ id: "p1", sessionId: "p1" }));

      const state = readAppNavigationState();

      expect(state.projects).toEqual([{ id: "p1", sessionId: "p1" }]);
      expect(state.activeProject).toBe("p1");
      expect(state.lastRealProject).toBe("p1");
      expect(state.lastRealProjectTab).toEqual({ id: "p1", sessionId: "p1" });
      expect(localStorage.getItem("ADS_WEB_PROJECTS")).toBeNull();
      expect(localStorage.getItem("ADS_WEB_ACTIVE_PROJECT")).toBeNull();
      expect(localStorage.getItem("ADS_WEB_LAST_REAL_PROJECT")).toBeNull();
      expect(localStorage.getItem("ADS_WEB_LAST_REAL_PROJECT_TAB")).toBeNull();

      const persisted = JSON.parse(localStorage.getItem(APP_STATE_STORAGE_KEY)!) as { version: number; projects: unknown };
      expect(persisted.version).toBe(1);
      expect(persisted.projects).toEqual([{ id: "p1", sessionId: "p1" }]);
    });

    it("round-trips writes without resurrecting legacy keys", () => {
      writeAppNavigationState({
        projects: [{ id: "p2" }],
        activeProject: "p2",
        lastRealProject: "p2",
        lastRealProjectTab: null,
      });
      const state = readAppNavigationState();
      expect(state.activeProject).toBe("p2");
      expect(state.lastRealProject).toBe("p2");
      expect(localStorage.getItem("ADS_WEB_PROJECTS")).toBeNull();
      expect(Object.keys(localStorage)).toEqual([APP_STATE_STORAGE_KEY]);
    });

    it("returns an empty state when nothing is stored", () => {
      const state = readAppNavigationState();
      expect(state.projects).toBeUndefined();
      expect(state.activeProject ?? null).toBeNull();
      expect(state.lastRealProject ?? null).toBeNull();
    });
  });

  it("writeProjectPreferences stores a versioned record", () => {
    writeProjectPreferences("p1", { version: 1, updatedAt: 5, mobileTab: "worker" });
    const record = JSON.parse(storedRaw("p1")!) as { version: number; mobileTab: string; updatedAt: number };
    expect(record.version).toBe(2);
    expect(record.mobileTab).toBe("worker");
    expect(record.updatedAt).toBeGreaterThan(0);
  });

  it("eagerly migrates v1 records to v2 in-place and removes zombie keys", () => {
    // Seed v1 preferences with advisor and worker keys
    localStorage.setItem(
      "ads.prefs.p1",
      JSON.stringify({
        version: 1,
        updatedAt: 100,
        mobileTab: "advisor",
        models: {
          advisor: { codex: { modelId: "gpt-5.5" } },
          worker: { default: { modelId: "gpt-5.5" } },
        },
        latestPrompts: {
          advisor: "old advisor prompt",
          worker: "old worker prompt",
        },
        laneGenerations: {
          advisor: 2,
          worker: 3,
        },
      }),
    );

    // Seed ads.app_state with legacy tab
    localStorage.setItem(
      APP_STATE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        updatedAt: 100,
        lastRealProjectTab: "worker",
      }),
    );

    // Seed zombie keys
    localStorage.setItem("ads.modelId.p1.advisor", "zombie-model");
    localStorage.setItem("ADS_WEB_LATEST_PROMPT:p1:advisor", "zombie-prompt");

    // Run eager migration
    const modified = eagerMigratePreferencesToV2();
    expect(modified).toBe(true);

    // Verify v2 project preferences record
    const migratedPrefs = JSON.parse(localStorage.getItem("ads.prefs.p1")!) as {
      version: number;
      mobileTab: string;
      models: Record<string, unknown>;
      latestPrompts: Record<string, string>;
      laneGenerations: Record<string, number>;
    };
    expect(migratedPrefs.version).toBe(2);
    expect(migratedPrefs.mobileTab).toBe("acopilot");
    expect(migratedPrefs.models.advisor).toBeUndefined();
    expect(migratedPrefs.models.worker).toBeUndefined();
    expect(migratedPrefs.models.acopilot).toBeDefined();
    expect(migratedPrefs.models.actions).toBeDefined();
    expect(migratedPrefs.latestPrompts.acopilot).toBe("old advisor prompt");
    expect(migratedPrefs.latestPrompts.actions).toBe("old worker prompt");
    expect(migratedPrefs.laneGenerations.acopilot).toBe(2);
    expect(migratedPrefs.laneGenerations.actions).toBe(3);

    // Verify app state rewrite
    const migratedAppState = JSON.parse(localStorage.getItem(APP_STATE_STORAGE_KEY)!) as {
      lastRealProjectTab: string;
    };
    expect(migratedAppState.lastRealProjectTab).toBe("actions");

    // Verify zombie keys are purged
    expect(localStorage.getItem("ads.modelId.p1.advisor")).toBeNull();
    expect(localStorage.getItem("ADS_WEB_LATEST_PROMPT:p1:advisor")).toBeNull();
  });
});
