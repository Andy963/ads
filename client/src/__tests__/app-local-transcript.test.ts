import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import App from "../App.vue";
import { createProjectRuntime } from "../app/projectRuntime";
import { createTranscriptCache, TRANSCRIPT_CACHE_PREFIX, TRANSCRIPT_OWNER_KEY } from "../app/transcriptCache";
import { legacyPendingPromptStorageKey, outboxStorageKey } from "../app/outbox";

const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ ApiClient: class { get = state.get; } }));
vi.mock("../api/ws", () => ({ AdsWebSocket: class { connect() {} close() {} } }));
const wrappers: ReturnType<typeof mount>[] = [];

function seed() {
  localStorage.setItem("ADS_WEB_PROJECTS", JSON.stringify([{ id: "default", sessionId: "default", path: "", name: "Default", chatSessionId: "main", initialized: true }]));
  localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "default");
  const cache = createTranscriptCache();
  cache.setOwner("user-1");
  for (const lane of ["advisor", "main"]) {
    const rt = createProjectRuntime({ maxLiveActivitySteps: 5 });
    cache.attach(rt, { projectId: "default", sessionId: "default", chatSessionId: lane, workspace: "" });
    rt.laneGeneration = 1;
    rt.transcriptReady = true;
    rt.transcriptCursor = 10;
    rt.messages.value = [{ id: `${lane}-answer`, role: "assistant", kind: "text", content: `Cached ${lane} answer` }];
  }
  cache.flush();
  cache.dispose();
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); state.get.mockReset(); seed(); });
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  localStorage.clear();
  sessionStorage.clear();
});

function mountApp() {
  const wrapper = mount(App, { attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

describe("cached app bootstrap and authentication", () => {
  it("renders cached messages in the initial mount before auth resolves, without granting send access", () => {
    state.get.mockReturnValue(new Promise(() => {}));
    const wrapper = mountApp();
    expect(wrapper.find(".app").exists()).toBe(true);
    expect(wrapper.find(".chat").text()).toContain("Cached advisor answer");
    expect(wrapper.find(".app").attributes("data-cache-read-only")).toBe("true");
    expect(wrapper.find("textarea.composer-input").attributes("disabled")).toBeDefined();
    const authStatusCalls = state.get.mock.calls.filter(([path]) => path === "/api/auth/status");
    expect(authStatusCalls).toHaveLength(1);
  });

  it("restores the selected mobile lane before its first render", () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    localStorage.setItem("ads.mobileWorkspaceTab.default", "worker");
    state.get.mockReturnValue(new Promise(() => {}));
    try {
      const wrapper = mountApp();
      // Both lane panels stay mounted; the restored worker lane shows its own cache.
      expect(wrapper.find('[data-testid="lane-panel-worker"] .chat').text()).toContain("Cached main answer");
      expect(wrapper.find('[data-testid="lane-panel-advisor"] .chat').text()).toContain("Cached advisor answer");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });

  it("keeps mobile settings and project mutations unavailable before authentication", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    state.get.mockReturnValue(new Promise(() => {}));
    try {
      const wrapper = mountApp();
      await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
      for (const testId of ["mobile-drawer-section-models", "mobile-drawer-section-prompts"]) {
        expect(wrapper.find(`[data-testid="${testId}"]`).attributes("disabled")).toBeDefined();
      }
      expect(wrapper.find(".projectAdd").attributes("disabled")).toBeDefined();
      expect(wrapper.find(".projectDragHandle").exists()).toBe(false);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });

  it("falls back to sign-in instead of crashing setup when storage is blocked", async () => {
    state.get.mockResolvedValue({ initialized: false });
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    try {
      const wrapper = mountApp();
      await flushPromises();
      expect(wrapper.find(".gate").text()).toContain("Admin is not initialized");
      expect(wrapper.find(".app").exists()).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  it("ignores malformed stored project rows during synchronous setup", () => {
    localStorage.setItem("ADS_WEB_PROJECTS", '[null,1,{},[]]');
    state.get.mockReturnValue(new Promise(() => {}));
    expect(() => mountApp()).not.toThrow();
  });

  it("does not alert for a superseded lane selection while browsing cached history", async () => {
    vi.useFakeTimers();
    state.get.mockReturnValue(new Promise(() => {}));
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    try {
      const wrapper = mountApp();
      await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
      await wrapper.find('[data-testid="lane-tab-advisor"]').trigger("click");
      await vi.advanceTimersByTimeAsync(400);
      expect(wrapper.find(".chat").text()).toContain("Cached advisor answer");
      expect(alert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps history readable after an offline reload and reauthenticates online without remounting it", async () => {
    state.get.mockRejectedValue(new TypeError("Network unavailable"));
    const wrapper = mountApp();
    await flushPromises();
    const row = wrapper.find(".msg").element;
    expect(wrapper.find(".chat").text()).toContain("Cached advisor answer");
    state.get.mockImplementation(async (path: string) => {
      if (path === "/api/auth/status") return { initialized: true };
      if (path === "/api/auth/me") return { id: "user-1", username: "Andy" };
      if (path === "/api/projects") return { projects: [], activeProjectId: null };
      if (path === "/api/paths/subdirs") return { dirs: [], allowedDirs: [] };
      return [];
    });
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    expect(wrapper.find(".app").attributes("data-cache-read-only")).toBe("false");
    expect(wrapper.find(".msg").element).toBe(row);
    expect(wrapper.find(".chat").text()).toContain("Cached advisor answer");
  });

  it("retries an online notification that arrives while the previous auth request is still pending", async () => {
    let rejectRequest!: (error: Error) => void;
    state.get.mockReturnValueOnce(new Promise((_, reject) => { rejectRequest = reject; }));
    state.get.mockImplementation(async (path: string) => {
      if (path === "/api/auth/status") return { initialized: true };
      if (path === "/api/auth/me") return { id: "user-1", username: "Andy" };
      if (path === "/api/projects") return { projects: [], activeProjectId: null };
      if (path === "/api/paths/subdirs") return { dirs: [], allowedDirs: [] };
      return [];
    });
    const wrapper = mountApp();
    const row = wrapper.find(".msg").element;
    window.dispatchEvent(new Event("online"));
    rejectRequest(new TypeError("Old offline request"));
    await flushPromises();
    expect(wrapper.find(".app").attributes("data-cache-read-only")).toBe("false");
    expect(wrapper.find(".msg").element).toBe(row);
  });

  it.each([401, 403])("purges private transcripts after an explicit auth denial (%s)", async (status) => {
    localStorage.setItem(outboxStorageKey("default", "main"), JSON.stringify({ pending: { clientMessageId: "old-input", text: "Private pending input", createdAt: 1 }, queued: [] }));
    localStorage.setItem("ADS_WEB_LATEST_PROMPT:default:advisor", "Private previous prompt");
    localStorage.setItem("unrelated-preference", "keep");
    sessionStorage.setItem(legacyPendingPromptStorageKey("default", "main"), "Private legacy input");
    sessionStorage.setItem("ADS_WEB_DRAFT_STASH", JSON.stringify({ projectId: "default", advisor: "Private draft" }));
    state.get.mockImplementation(async (path: string) => {
      if (path === "/api/auth/status") return { initialized: true };
      throw new Error("Unauthorized", { cause: { status } });
    });
    const wrapper = mountApp();
    expect(wrapper.find(".chat").text()).toContain("Cached advisor answer");
    await flushPromises();
    expect(wrapper.find(".app").exists()).toBe(false);
    expect(wrapper.find("[data-testid='login-username']").exists()).toBe(true);
    expect(localStorage.getItem(TRANSCRIPT_OWNER_KEY)).toBeNull();
    expect(Object.keys(localStorage).filter((key) => key.startsWith(TRANSCRIPT_CACHE_PREFIX))).toEqual([]);
    expect(localStorage.getItem(outboxStorageKey("default", "main"))).toBeNull();
    expect(localStorage.getItem("ADS_WEB_LATEST_PROMPT:default:advisor")).toBeNull();
    expect(sessionStorage.getItem(legacyPendingPromptStorageKey("default", "main"))).toBeNull();
    expect(sessionStorage.getItem("ADS_WEB_DRAFT_STASH")).toBeNull();
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
  });

  it("does not expose the previous account's transcript after another account authenticates", async () => {
    state.get.mockImplementation(async (path: string) => {
      if (path === "/api/auth/status") return { initialized: true };
      if (path === "/api/auth/me") return { id: "user-2", username: "Other" };
      if (path === "/api/projects") return { projects: [], activeProjectId: null };
      if (path === "/api/paths/subdirs") return { dirs: [], allowedDirs: [] };
      return [];
    });
    const wrapper = mountApp();
    await flushPromises();
    expect(wrapper.find(".chat").text()).not.toContain("Cached advisor answer");
    expect(localStorage.getItem(TRANSCRIPT_OWNER_KEY)).toBe("user-2");
    expect(Object.keys(localStorage).filter((key) => key.startsWith(TRANSCRIPT_CACHE_PREFIX))).toEqual([]);
  });
});
