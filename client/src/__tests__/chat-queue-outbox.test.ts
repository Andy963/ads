import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mount, shallowMount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";

import { createAppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import { createExecuteActions } from "../app/chatExecute";
import {
  createOutboxStore,
  isEmptyOutboxSnapshot,
  legacyPendingPromptStorageKey,
  outboxStorageKey,
  OUTBOX_CHANNEL_NAME,
  type OutboxSnapshot,
} from "../app/outbox";
import MainChat from "../components/MainChat.vue";
import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";
import type { ProjectRuntime, QueuedPrompt } from "../app/controller";

// --- Shared helpers ---------------------------------------------------------

type SentFrame = { payload: Record<string, unknown>; clientMessageId: string };

/**
 * One harness standing in for the three near-identical copies the source
 * files carried: an app context, chat actions, a ws message handler, and a
 * fake socket that records outgoing prompts. Each suite passes its own
 * sessionId so a lingering outbox broadcast from an earlier suite can never
 * land on a later suite's runtime (they share one BroadcastChannel name).
 */
const mountChatHarness = (options: Partial<ProjectRuntime> & { sessionId?: string } = {}) => {
  const { sessionId = "session-1", ...overrides } = options;
  const ctx = createAppContext();
  const chat = createChatActions(ctx as never);
  const rt = ctx.activeRuntime.value as ProjectRuntime;
  rt.projectSessionId = sessionId;
  rt.chatSessionId = "main";
  rt.connected.value = true;
  rt.inputLocked.value = false;
  Object.assign(rt, overrides);
  const sentFrames: SentFrame[] = [];
  rt.ws = {
    sendPrompt: (payload: unknown, clientMessageId?: string) => {
      sentFrames.push({
        payload: (payload ?? {}) as Record<string, unknown>,
        clientMessageId: String(clientMessageId ?? ""),
      });
      return true;
    },
    send: () => true,
    clearHistory: () => {},
  } as never;
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    wsInstance: { send: () => true } as never,
    randomId: (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
    maxTurnCommands: 5,
    updateProject: () => undefined,
    ...chat,
  } as never);
  return { chat, rt, handler, sentFrames };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

const runningCard = (overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: "q-running",
  clientMessageId: "cmid-abort",
  text: "run the long task",
  images: [],
  createdAt: 1000,
  agentId: "codex",
  model: "auto",
  deliveryStatus: "running",
  serverQueueTracked: true,
  queueLaneGeneration: 1,
  ...overrides,
});

// --- Actions lane queue visibility (App mount, mocked api/ws) ---------------

const postSpy = vi.fn();
const getSpy = vi.fn();

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (url === "/api/models") return [] as T;
      if (url.startsWith("/api/paths/validate")) return { ok: false } as T;
      if (url === "/api/projects") {
        return {
          projects: [{ id: "p-1", name: "ads", workspaceRoot: "/home/andy/repos/ads", chatSessionId: "main" }],
          activeProjectId: "p-1",
        } as T;
      }
      if (url.startsWith("/api/actions/jobs")) {
        return getSpy(url) as T;
      }
      return {} as T;
    }

    async post<T>(url: string, body: unknown): Promise<T> {
      return postSpy(url, body) as T;
    }

    async patch<T>(): Promise<T> {
      throw new Error("not implemented");
    }

    async delete<T>(): Promise<T> {
      throw new Error("not implemented");
    }
  }

  return { ApiClient };
});

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason?: string }) => void;
    onError?: () => void;
    onMessage?: (msg: unknown) => void;

    clearHistory = vi.fn();

    constructor(_: { sessionId: string; chatSessionId?: string }) {}

    connect(): void {}
    close(): void {}
    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
  }

  return { AdsWebSocket };
});

vi.mock("../components/LoginGate.vue", () => {
  return {
    default: defineComponent({
      name: "LoginGate",
      emits: ["logged-in"],
      mounted() {
        this.$emit("logged-in", { id: "u-1", username: "admin" });
      },
      template: "<div />",
    }),
  };
});

describe("Actions lane queue visibility and manual start button", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    postSpy.mockReset();
    getSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders one compact line per queued task with the start button inline, and triggers /api/actions/queue/start on click", async () => {
    const mockJobs = [
      {
        id: "job-1",
        project_id: "/home/andy/repos/ads",
        issue_id: 341,
        issue_title: "Implement manual start button",
        status: "queued",
        current_step: "Developer step is visible in the queue",
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        id: "job-2",
        project_id: "/home/andy/repos/ads",
        issue_id: 342,
        issue_title: "Second queued task",
        status: "queued",
        error_message: "queued details stay in history",
        created_at: Date.now() + 100,
        updated_at: Date.now() + 100,
      },
    ];

    getSpy.mockResolvedValue(mockJobs);
    postSpy.mockResolvedValue({ ok: true });
    localStorage.setItem("ads.app_state", JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      projects: [{ id: "p-1", sessionId: "p-1", path: "/home/andy/repos/ads", name: "ads", chatSessionId: "main", initialized: true }],
      activeProject: "p-1",
    }));

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    // Verify banner and badges exist
    const banner = wrapper.find('[data-testid="actions-job-banner"]');
    expect(banner.exists()).toBe(true);
    expect(banner.findAll('[data-testid="actions-queue-row"]')).toHaveLength(2);
    expect(banner.text()).toContain("Implement manual start button");
    expect(banner.text()).toContain("Second queued task");
    expect(banner.text()).toContain("Developer step is visible in the queue");
    expect(banner.text()).not.toContain("queued details stay in history");

    // The queue depth badge and the "Actions 队列" heading were removed: they
    // are chrome, and the banner is now one line per task.
    expect(banner.find('[data-testid="actions-queue-count-badge"]').exists()).toBe(false);
    expect(banner.text()).not.toContain("Actions 队列");
    expect(banner.text()).not.toContain("个任务");

    const rows = banner.findAll('[data-testid="actions-queue-row"]');
    const startBtn = rows[0].find('[data-testid="btn-action-start"]');
    expect(startBtn.exists()).toBe(true);
    expect(startBtn.text()).toContain("启动执行");
    // Only the active job carries the controls; the other job stays text-only.
    expect(rows[1].find('[data-testid="btn-action-start"]').exists()).toBe(false);

    // Click start button and verify API invocation
    await startBtn.trigger("click");
    await settleUi(wrapper);

    expect(postSpy).toHaveBeenCalledWith("/api/actions/queue/start", expect.objectContaining({
      projectId: expect.any(String),
      repoPath: "/home/andy/repos/ads",
    }));

    wrapper.unmount();
  });

  it("refreshes the queue when a queued job event arrives after a failed job", async () => {
    getSpy.mockResolvedValueOnce([
      {
        id: "job-failed",
        project_id: "/home/andy/repos/ads",
        issue_id: 344,
        issue_title: "Failed task",
        status: "failed",
        created_at: 1000,
        updated_at: 1000,
      },
    ]);
    localStorage.setItem("ads.app_state", JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      projects: [{ id: "p-1", sessionId: "p-1", path: "/home/andy/repos/ads", name: "ads", chatSessionId: "main", initialized: true }],
      activeProject: "p-1",
    }));

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="actions-queue-count-badge"]').exists()).toBe(false);

    getSpy.mockResolvedValue([
      {
        id: "job-new",
        project_id: "/home/andy/repos/ads",
        issue_id: 345,
        issue_title: "New queued task",
        status: "queued",
        created_at: 2000,
        updated_at: 2000,
      },
    ]);
    const onJobUpdate = (window as any).__ADS_ON_ACTION_JOB_UPDATED__;
    expect(typeof onJobUpdate).toBe("function");
    onJobUpdate({ type: "action_job_updated", jobId: "job-new", issueId: 345, status: "queued" });
    await settleUi(wrapper);

    const bannerAfterUpdate = wrapper.find('[data-testid="actions-job-banner"]');
    expect(bannerAfterUpdate.text()).toContain("New queued task");
    expect(bannerAfterUpdate.find('[data-testid="actions-queue-count-badge"]').exists()).toBe(false);

    onJobUpdate({ type: "action_job_updated", jobId: "job-new", issueId: 345, status: "queued" });
    await settleUi(wrapper);
    expect(wrapper.findAll('[data-testid="actions-queue-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="actions-queue-count-badge"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("does not expose a manual merge action while automatic merge is running", async () => {
    getSpy.mockResolvedValue([
      {
        id: "job-merging",
        project_id: "/home/andy/repos/ads",
        issue_id: 343,
        issue_title: "Automatic merge delivery",
        status: "waiting_merge",
        pr_number: 356,
        pr_url: "https://github.com/Andy963/ads/pull/356",
        current_step: "Review passed. PR #356 created. Starting automatic merge and cleanup.",
        created_at: 1000,
        updated_at: 2000,
      },
    ]);
    localStorage.setItem("ads.app_state", JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      projects: [{ id: "p-1", sessionId: "p-1", path: "/home/andy/repos/ads", name: "ads", chatSessionId: "main", initialized: true }],
      activeProject: "p-1",
    }));

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="actions-job-banner"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="btn-action-merge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="acopilot-waiting-merge-banner"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="btn-action-cancel"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("prioritizes active running job over newer queued job in activeActionJob banner (Issue #345)", async () => {
    const mockJobs = [
      {
        id: "job-2",
        project_id: "/home/andy/repos/ads",
        issue_id: 342,
        issue_title: "Newer Queued Task",
        status: "queued",
        created_at: 2000,
        updated_at: 2000,
      },
      {
        id: "job-1",
        project_id: "/home/andy/repos/ads",
        issue_id: 341,
        issue_title: "Older Running Task",
        status: "running",
        current_step: "Developer executing implementation on feature branch",
        created_at: 1000,
        updated_at: 1000,
      },
    ];

    getSpy.mockResolvedValue(mockJobs);
    localStorage.setItem("ads.app_state", JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      projects: [{ id: "p-1", sessionId: "p-1", path: "/home/andy/repos/ads", name: "ads", chatSessionId: "main", initialized: true }],
      activeProject: "p-1",
    }));

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    const banner = wrapper.find('[data-testid="actions-job-banner"]');
    expect(banner.exists()).toBe(true);
    const rows = banner.findAll('[data-testid="actions-queue-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("RUNNING");
    expect(rows[0].text()).toContain("Older Running Task");
    expect(rows[1].text()).toContain("QUEUED");
    expect(rows[1].text()).toContain("Newer Queued Task");
    expect(banner.text()).toContain("Developer executing implementation on feature branch");
    expect(rows[0].find(`[data-testid="actions-job-step-job-1"]`).exists()).toBe(true);

    wrapper.unmount();
  });

  it("shows blocking notice and blocks start API when another job is active (Issue #345)", async () => {
    const mockJobs = [
      {
        id: "job-1",
        project_id: "/home/andy/repos/ads",
        issue_id: 341,
        issue_title: "Active Running Job",
        status: "running",
        created_at: 1000,
        updated_at: 1000,
      },
    ];

    getSpy.mockResolvedValue(mockJobs);
    localStorage.setItem("ads.app_state", JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      projects: [{ id: "p-1", sessionId: "p-1", path: "/home/andy/repos/ads", name: "ads", chatSessionId: "main", initialized: true }],
      activeProject: "p-1",
    }));

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    // Call triggerStartActionQueue on the component instance
    await (wrapper.vm as any).triggerStartActionQueue();
    await settleUi(wrapper);

    // Start API must NOT be called when a running job exists
    expect(postSpy).not.toHaveBeenCalled();
    expect((wrapper.vm as any).apiNotice).toContain("已有活跃任务正在执行中");

    wrapper.unmount();
  });

  it("keeps blocked job detail out of the banner and prevents the queue from advancing", async () => {
    getSpy.mockResolvedValue([
      {
        id: "job-blocked",
        project_id: "/home/andy/repos/ads",
        issue_id: 345,
        issue_title: "Recover Actions reliability",
        status: "blocked",
        current_step: "Human attention required after 2 rework attempts.",
        error_message: "PR creation failed twice",
        rework_count: 2,
        attempts_json: JSON.stringify([
          { attempt: 1, stage: "Reviewer rejection", failure: "Reviewer rejection failed: Defect 1", ts: 1 },
          { attempt: 2, stage: "Developer implementation", failure: "Developer implementation failed: tests failed", ts: 2 },
        ]),
        created_at: 1000,
        updated_at: 2000,
      },
      {
        id: "job-queued",
        project_id: "/home/andy/repos/ads",
        issue_id: 346,
        issue_title: "Queued behind blocked job",
        status: "queued",
        created_at: 3000,
        updated_at: 3000,
      },
    ]);
    localStorage.setItem("ads.app_state", JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      projects: [{ id: "p-1", sessionId: "p-1", path: "/home/andy/repos/ads", name: "ads", chatSessionId: "main", initialized: true }],
      activeProject: "p-1",
    }));

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    const banner = wrapper.find('[data-testid="actions-job-banner"]');
    const rows = banner.findAll('[data-testid="actions-queue-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("BLOCKED");
    expect(rows[0].text()).toContain("Recover Actions reliability");
    expect(rows[1].text()).toContain("QUEUED");
    expect(rows[1].text()).toContain("Queued behind blocked job");
    // The failure text lives in the lane conversation, so the banner keeps only
    // the title and the blocked duration.
    expect(banner.text()).not.toContain("Human attention required after 2 rework attempts.");
    expect(banner.text()).not.toContain("Attempt 1");
    expect(banner.text()).not.toContain("Defect 1");
    expect(banner.text()).not.toContain("PR creation failed twice");
    expect(rows[0].find('[data-testid="actions-job-step-job-blocked"]').exists()).toBe(false);
    expect(rows[0].text()).toContain("Blocked for");

    await (wrapper.vm as any).triggerStartActionQueue();
    await settleUi(wrapper);
    expect(postSpy).not.toHaveBeenCalled();
    expect((wrapper.vm as any).apiNotice).toContain("PR creation failed twice");

    wrapper.unmount();
  });
});

// --- Outbox store (pure unit) -----------------------------------------------

const OUTBOX_UNIT_KEY = outboxStorageKey("session-a", "main");

function outboxPrompt(clientMessageId: string, text: string) {
  return { clientMessageId, text, createdAt: 1_000 };
}

describe("outbox store", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("survives a reload: the queue is read back from localStorage, not sessionStorage", () => {
    const store = createOutboxStore();
    store.write(OUTBOX_UNIT_KEY, { pending: outboxPrompt("m-1", "sent"), sent: [], queued: [outboxPrompt("m-2", "waiting")] });

    // A fresh store stands in for a reloaded tab.
    const reloaded = createOutboxStore().read(OUTBOX_UNIT_KEY);
    expect(reloaded.pending?.clientMessageId).toBe("m-1");
    expect(reloaded.queued.map((entry) => entry.text)).toEqual(["waiting"]);
    expect(sessionStorage.getItem(OUTBOX_UNIT_KEY)).toBeNull();
  });

  it("removes the storage entry once the outbox drains", () => {
    const store = createOutboxStore();
    store.write(OUTBOX_UNIT_KEY, { pending: outboxPrompt("m-1", "sent"), sent: [], queued: [] });
    expect(localStorage.getItem(OUTBOX_UNIT_KEY)).not.toBeNull();

    store.write(OUTBOX_UNIT_KEY, { pending: null, sent: [], queued: [] });
    expect(localStorage.getItem(OUTBOX_UNIT_KEY)).toBeNull();
    expect(isEmptyOutboxSnapshot(store.read(OUTBOX_UNIT_KEY))).toBe(true);
  });

  it("notifies subscribers when another tab changes the same lane", async () => {
    const writer = createOutboxStore();
    const reader = createOutboxStore();
    const seen: Array<{ key: string; snapshot: OutboxSnapshot }> = [];
    reader.subscribe((key, snapshot) => seen.push({ key, snapshot }));

    writer.write(OUTBOX_UNIT_KEY, { pending: null, sent: [], queued: [outboxPrompt("m-9", "from the other tab")] });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.key).toBe(OUTBOX_UNIT_KEY);
    expect(seen[0]?.snapshot.queued.map((entry) => entry.text)).toEqual(["from the other tab"]);

    writer.close();
    reader.close();
  });

  it("drops malformed and duplicate entries instead of replaying them", () => {
    localStorage.setItem(
      OUTBOX_UNIT_KEY,
      JSON.stringify({
        pending: { text: "no client message id" },
        queued: [outboxPrompt("m-1", "first"), outboxPrompt("m-1", "duplicate"), null, "nonsense"],
      }),
    );

    const snapshot = createOutboxStore().read(OUTBOX_UNIT_KEY);
    expect(snapshot.pending).toBeNull();
    expect(snapshot.queued.map((entry) => entry.text)).toEqual(["first"]);
  });

  it("adopts a pending prompt written by the previous sessionStorage layout", () => {
    const legacyKey = legacyPendingPromptStorageKey("session-a", "main");
    sessionStorage.setItem(legacyKey, JSON.stringify(outboxPrompt("m-legacy", "written before the upgrade")));

    const store = createOutboxStore();
    store.migrateLegacyPending({ key: OUTBOX_UNIT_KEY, legacyKey });

    expect(store.read(OUTBOX_UNIT_KEY).pending?.text).toBe("written before the upgrade");
    // Consumed, so a later migration cannot resurrect it.
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });

  it("keeps a newer pending prompt when a legacy entry is still around", () => {
    const legacyKey = legacyPendingPromptStorageKey("session-a", "main");
    sessionStorage.setItem(legacyKey, JSON.stringify(outboxPrompt("m-legacy", "stale")));
    const store = createOutboxStore();
    store.write(OUTBOX_UNIT_KEY, { pending: outboxPrompt("m-current", "current"), sent: [], queued: [] });

    store.migrateLegacyPending({ key: OUTBOX_UNIT_KEY, legacyKey });

    expect(store.read(OUTBOX_UNIT_KEY).pending?.clientMessageId).toBe("m-current");
  });

  it("keeps working when storage is unavailable", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const store = createOutboxStore();

    expect(() => store.write(OUTBOX_UNIT_KEY, { pending: outboxPrompt("m-1", "x"), sent: [], queued: [] })).not.toThrow();
    setItem.mockRestore();
    expect(isEmptyOutboxSnapshot(store.read(OUTBOX_UNIT_KEY))).toBe(true);
  });

  it("retains every sent prompt until its own acknowledgement arrives", () => {
    const store = createOutboxStore();
    store.write(OUTBOX_UNIT_KEY, {
      pending: null,
      sent: [
        { ...outboxPrompt("m-1", "first"), sentAwaitingAck: true },
        { ...outboxPrompt("m-2", "second"), sentAwaitingAck: true },
      ],
      queued: [],
    });

    const reloaded = createOutboxStore().read(OUTBOX_UNIT_KEY);
    expect(reloaded.sent.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(reloaded.sent.every((entry) => entry.sentAwaitingAck)).toBe(true);
  });

  it("retains consumed ids after the prompt entries are cleared", () => {
    const store = createOutboxStore();
    store.write(OUTBOX_UNIT_KEY, {
      pending: null,
      sent: [],
      queued: [],
      dismissed: [],
      consumed: ["m-consumed"],
    });

    const reloaded = createOutboxStore().read(OUTBOX_UNIT_KEY);
    expect(reloaded.pending).toBeNull();
    expect(reloaded.sent).toEqual([]);
    expect(reloaded.queued).toEqual([]);
    expect(reloaded.consumed).toEqual(["m-consumed"]);
    expect(localStorage.getItem(OUTBOX_UNIT_KEY)).not.toBeNull();
  });
});

// --- Queued prompt bubbles (issue-328, composer panel) -----------------------

describe("issue-328 queued prompt bubbles", () => {
  it("renders queued prompts with order badges and emits removeQueued on click", async () => {
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        draft: "",
        queuedPrompts: [
          { id: "q-1", clientMessageId: "c-1", text: "First long prompt line 1\nline 2\nline 3\nline 4", imagesCount: 0, createdAt: 1 },
          { id: "q-2", clientMessageId: "c-2", text: "Second prompt", imagesCount: 2, createdAt: 2 },
        ],
        pendingImages: [],
        connected: true,
        busy: false,
      },
    });

    const queueItems = wrapper.findAll(".queue-item");
    expect(queueItems).toHaveLength(2);

    // Verify order badges
    expect(queueItems[0]?.find(".queue-badge").text()).toBe("#1");
    expect(queueItems[1]?.find(".queue-badge").text()).toBe("#2");

    // Verify text content
    expect(queueItems[0]?.find(".queue-text").text()).toContain("First long prompt");
    expect(queueItems[1]?.find(".queue-text").text()).toContain("Second prompt");
    expect(queueItems[1]?.find(".queue-sub").text()).toContain("图片 x2");

    // Verify deletion emit
    await queueItems[0]?.find(".queue-action--remove").trigger("click");
    expect(wrapper.emitted("removeQueued")).toEqual([["q-1"]]);

    await queueItems[1]?.find(".queue-action--remove").trigger("click");
    expect(wrapper.emitted("removeQueued")).toEqual([["q-1"], ["q-2"]]);
  });

  it("offers explicit retry and removal for a failed server queue card", async () => {
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        draft: "",
        queuedPrompts: [{
          id: "q-failed",
          text: "Interrupted turn",
          imagesCount: 0,
          deliveryStatus: "failed",
          queueError: "Prompt execution was interrupted",
        }],
        pendingImages: [],
        connected: true,
        busy: false,
      },
    });

    const item = wrapper.get(".queue-item");
    expect(item.get(".queue-status").attributes("title")).toBe("Prompt execution was interrupted");
    await item.get(".queue-action--retry").trigger("click");
    await item.get(".queue-action--remove").trigger("click");
    expect(wrapper.emitted("retryQueued")).toEqual([["q-failed"]]);
    expect(wrapper.emitted("removeQueued")).toEqual([["q-failed"]]);
  });
});

// --- Every queued card offers an exit (composer panel) -----------------------

const ComposerHost = defineComponent({
  components: { MainChatComposerPanel },
  setup() {
    return { draft: ref(""), queued: ref<QueuedPrompt[]>([]) };
  },
  template: `
    <div class="detail">
      <div class="chat"></div>
      <MainChatComposerPanel
        v-model:draft="draft"
        :queued-prompts="queued"
        :pending-images="[]"
        :connected="true"
        :busy="false"
        connection-status-message="Connected"
      />
    </div>
  `,
});

describe("every queued card offers an exit", () => {
  it("renders a remove action for all delivery states", async () => {
    // Running and queued cards used to render no button at all, so a card that
    // never reached a terminal state could not be cleared by hand.
    const statuses = [undefined, "offline", "awaiting_ack", "queued", "running", "failed"] as const;
    for (const deliveryStatus of statuses) {
      const wrapper = mount(ComposerHost, { attachTo: document.body });
      (wrapper.vm as unknown as { queued: QueuedPrompt[] }).queued = [
        { ...runningCard(), deliveryStatus: deliveryStatus as QueuedPrompt["deliveryStatus"] },
      ];
      await wrapper.vm.$nextTick();
      const label = `status=${String(deliveryStatus)}`;
      expect(wrapper.find(".queue-action--remove").exists(), label).toBe(true);
      wrapper.unmount();
    }
  });
});

// --- Execute preview queue ordering ------------------------------------------

describe("execute preview queue ordering", () => {
  it("keeps only the newest command block when older commands receive later output", async () => {
    const rt = {
      messages: ref([] as Array<any>),
      executePreviewByKey: new Map<string, any>(),
      executeOrder: [] as string[],
      recentCommands: ref([] as string[]),
      turnCommands: [] as string[],
      seenCommandIds: new Set<string>(),
    } as any;

    const { upsertExecuteBlock } = createExecuteActions({
      runtimeOrActive: () => rt,
      setMessages: (items) => {
        rt.messages.value = items;
      },
      pushRecentCommand: () => {},
      randomId: () => "id",
      maxExecutePreviewLines: 1,
      maxTurnCommands: 64,
      isLiveMessageId: () => false,
    });

    upsertExecuteBlock("k1", "cmd-1", "$ cmd-1\nout-1\n", rt);
    upsertExecuteBlock("k2", "cmd-2", "$ cmd-2\nout-2\n", rt);
    upsertExecuteBlock("k3", "cmd-3", "$ cmd-3\nout-3\n", rt);
    upsertExecuteBlock("k4", "cmd-4", "$ cmd-4\nout-4\n", rt);

    upsertExecuteBlock("k2", "cmd-2", "tail-2\n", rt);

    const executeMessages = rt.messages.value.filter((m: any) => m.kind === "execute");
    expect(executeMessages.map((m: any) => m.command)).toEqual(["cmd-4"]);

    const wrapper = mount(MainChat, {
      props: {
        messages: rt.messages.value,
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    expect(wrapper.findAll(".execute-block")).toHaveLength(1);
    expect(wrapper.findAll(".execute-cmd").map((node) => node.text())).toEqual(["cmd-4"]);

    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);

    wrapper.unmount();
  });

  it("strips the redundant `$ <command>` echo even when output starts with newlines", () => {
    const rt = {
      messages: ref([] as Array<any>),
      executePreviewByKey: new Map<string, any>(),
      executeOrder: [] as string[],
      recentCommands: ref([] as string[]),
      turnCommands: [] as string[],
      seenCommandIds: new Set<string>(),
    } as any;

    const { upsertExecuteBlock } = createExecuteActions({
      runtimeOrActive: () => rt,
      setMessages: (items) => {
        rt.messages.value = items;
      },
      pushRecentCommand: () => {},
      randomId: () => "id",
      maxExecutePreviewLines: 8,
      maxTurnCommands: 64,
      isLiveMessageId: () => false,
    });

    upsertExecuteBlock("k1", "cmd-1", "\n\n$ cmd-1\nout-1\n", rt);

    const executeMessage = rt.messages.value.find((m: any) => m.kind === "execute" && m.command === "cmd-1");
    expect(executeMessage?.content).toBe("out-1");
  });

  it("clears live execute previews before the next turn reuses command keys", () => {
    const rt = {
      messages: ref([] as Array<any>),
      executePreviewByKey: new Map<string, any>(),
      executeOrder: [] as string[],
      recentCommands: ref([] as string[]),
      turnCommands: [] as string[],
      turnCommandCount: 0,
      seenCommandIds: new Set<string>(),
    } as any;
    const { upsertExecuteBlock, finalizeCommandBlock } = createExecuteActions({
      runtimeOrActive: () => rt,
      setMessages: (items) => {
        rt.messages.value = items;
      },
      pushRecentCommand: () => {},
      randomId: () => "id",
      maxExecutePreviewLines: 8,
      maxTurnCommands: 64,
      isLiveMessageId: () => false,
    });

    upsertExecuteBlock("k1", "cmd-1", "$ cmd-1\nout-1\n", rt);
    finalizeCommandBlock(rt);
    upsertExecuteBlock("k1", "cmd-1", "$ cmd-1\nout-2\n", rt);

    const executeMessages = rt.messages.value.filter((m: any) => m.kind === "execute");
    expect(executeMessages).toHaveLength(1);
    expect(executeMessages[0]).toMatchObject({
      id: "exec:k1",
      command: "cmd-1",
      content: "out-2",
      streaming: true,
    });
  });

  it("inserts the current execute preview below the current turn content", () => {
    const rt = {
      messages: ref([
        { id: "u-1", role: "user", kind: "text", content: "old prompt" },
        { id: "exec:old", role: "system", kind: "execute", command: "old-cmd", content: "old", streaming: false },
        { id: "u-2", role: "user", kind: "text", content: "new prompt" },
        { id: "a-2", role: "assistant", kind: "text", content: "", streaming: true },
      ] as Array<any>),
      executePreviewByKey: new Map<string, any>(),
      executeOrder: [] as string[],
      recentCommands: ref([] as string[]),
      turnCommands: [] as string[],
      turnCommandCount: 0,
      seenCommandIds: new Set<string>(),
    } as any;

    const { upsertExecuteBlock } = createExecuteActions({
      runtimeOrActive: () => rt,
      setMessages: (items) => {
        rt.messages.value = items;
      },
      pushRecentCommand: () => {},
      dropEmptyAssistantPlaceholder: () => {},
      randomId: () => "id",
      maxExecutePreviewLines: 8,
      maxTurnCommands: 64,
      isLiveMessageId: () => false,
    });

    upsertExecuteBlock("new", "new-cmd", "$ new-cmd\nrunning\n", rt);

    const messages = rt.messages.value;
    const newUserIndex = messages.findIndex((m: any) => m.id === "u-2");
    const newExecuteIndex = messages.findIndex((m: any) => m.id === "exec:new");
    const assistantIndex = messages.findIndex((m: any) => m.id === "a-2");

    expect(newExecuteIndex).toBeGreaterThan(assistantIndex);
    expect(newExecuteIndex).toBeGreaterThan(newUserIndex);
  });
});

// --- Dismissed queue card persistence ----------------------------------------

const DISMISSED_OUTBOX_KEY = outboxStorageKey("session-dismissed", "main");

const mountDismissedHarness = () =>
  mountChatHarness({ sessionId: "session-dismissed", laneGeneration: 1 });

const dismissedCard = (overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: "q-1",
  clientMessageId: "cmid-gone",
  text: "restore the backend context thread",
  images: [],
  createdAt: 1000,
  agentId: "claude",
  model: "auto",
  deliveryStatus: "queued",
  serverQueueTracked: true,
  restoredFromStorage: true,
  queueLaneGeneration: 1,
  ...overrides,
});

const readDismissedOutbox = (): { queued: unknown[]; dismissed: string[] } => {
  const raw = localStorage.getItem(DISMISSED_OUTBOX_KEY);
  if (!raw) return { queued: [], dismissed: [] };
  const parsed = JSON.parse(raw) as { queued?: unknown[]; dismissed?: string[] };
  return { queued: parsed.queued ?? [], dismissed: parsed.dismissed ?? [] };
};

describe("dismissed queue cards stay dismissed across a restart", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("honours a dismissal for an entry that is still listed in the outbox", () => {
    // Removing a card leaves it in the persisted outbox, so storage holds both
    // the stale entry and the dismissal. The dismissal has to win, otherwise the
    // next reconnect rebuilds a card the user explicitly deleted.
    localStorage.setItem(DISMISSED_OUTBOX_KEY, JSON.stringify({
      pending: null,
      sent: [],
      queued: [{ ...dismissedCard(), deliveryStatus: "offline" }],
      dismissed: ["cmid-gone"],
    }));

    const { chat, rt } = mountDismissedHarness();
    chat.restorePendingPrompt(rt);

    expect(Array.from(rt.dismissedPromptIds ?? [])).toEqual(["cmid-gone"]);
    expect(rt.queuedPrompts.value).toEqual([]);
  });

  it("does not write a dismissed card back into the outbox", async () => {
    const { chat, rt } = mountDismissedHarness();
    rt.queuedPrompts.value = [dismissedCard()];

    chat.removeQueuedPrompt("q-1", rt);
    await settle();

    expect(rt.queuedPrompts.value).toEqual([]);
    // Re-persisting it is what closed the loop: restore rebuilt the card, the
    // snapshot flipped it to `offline`, and the watcher stored it again.
    expect(readDismissedOutbox().queued).toEqual([]);
    expect(readDismissedOutbox().dismissed).toEqual(["cmid-gone"]);
  });

  it("does not resurrect a dismissed card when a later snapshot omits it", async () => {
    const { chat, rt, handler } = mountDismissedHarness();
    rt.queuedPrompts.value = [dismissedCard()];
    chat.removeQueuedPrompt("q-1", rt);
    await settle();

    handler({ type: "prompt_queue_snapshot", entries: [] });
    await settle();

    expect(rt.queuedPrompts.value).toEqual([]);
    expect(readDismissedOutbox().queued).toEqual([]);
  });

  it("drops an already-dismissed offline card during snapshot reconciliation", async () => {
    // The snapshot tail keeps `offline` cards unconditionally, so a dismissed
    // card that is already marked offline used to survive it. Removal has to be
    // authoritative at this layer too, or the card is persisted again.
    const { rt, handler } = mountDismissedHarness();
    rt.dismissedPromptIds = new Set(["cmid-gone"]);
    rt.queuedPrompts.value = [dismissedCard({ deliveryStatus: "offline" })];

    handler({ type: "prompt_queue_snapshot", entries: [] });
    await settle();

    expect(rt.queuedPrompts.value).toEqual([]);
  });

  it("breaks the dismiss -> offline -> persist -> restore cycle end to end", async () => {
    // Session 1: the user deletes a card that the server still tracks.
    const first = mountDismissedHarness();
    first.rt.queuedPrompts.value = [dismissedCard()];
    first.chat.removeQueuedPrompt("q-1", first.rt);
    await settle();
    expect(readDismissedOutbox().dismissed).toEqual(["cmid-gone"]);

    // Session 2: a restart, then the server re-advertises the durable row.
    const second = mountDismissedHarness();
    second.chat.restorePendingPrompt(second.rt);
    await settle();
    second.handler({
      type: "prompt_queue_snapshot",
      entries: [{
        clientMessageId: "cmid-gone",
        status: "failed",
        position: 0,
        attempts: 1,
        createdAt: 1000,
        updatedAt: 1000,
        lastError: "Prompt execution was interrupted before completion.",
        laneGeneration: 1,
      }],
    });
    await settle();

    expect(second.rt.queuedPrompts.value).toEqual([]);
    // And nothing was written back that a third session could pick up.
    expect(readDismissedOutbox().queued).toEqual([]);
  });

  it("dismisses and cancels a queued card the server has not acked yet", async () => {
    // A card that only exists locally has no serverQueueTracked flag, so the
    // delete used to skip persistence entirely and return on the next restart.
    const sent: Array<{ type: string; clientMessageId?: string }> = [];
    const { chat, rt } = mountDismissedHarness();
    rt.ws = {
      sendPrompt: () => true,
      send: (type: string, _payload?: unknown, options?: { clientMessageId?: string }) => {
        sent.push({ type, clientMessageId: options?.clientMessageId });
        return true;
      },
      clearHistory: () => {},
    } as never;
    rt.queuedPrompts.value = [dismissedCard({ serverQueueTracked: false, restoredFromStorage: false, deliveryStatus: "awaiting_ack" })];

    chat.removeQueuedPrompt("q-1", rt);
    await settle();

    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.dismissedPromptIds?.has("cmid-gone")).toBe(true);
    expect(readDismissedOutbox().dismissed).toEqual(["cmid-gone"]);
    expect(sent).toEqual([{ type: "cancel_prompt", clientMessageId: "cmid-gone" }]);
  });

  it("drops a card cancelled in another tab without cancelling again", async () => {
    // prompt_queue_cancelled is the server's broadcast of someone else's
    // delete. Re-sending a cancel for it would be redundant traffic, and the
    // local dismissal still has to land so a later snapshot cannot restore it.
    const sent: string[] = [];
    const { rt, handler } = mountDismissedHarness();
    rt.ws = {
      sendPrompt: () => true,
      send: (type: string) => { sent.push(type); return true; },
      clearHistory: () => {},
    } as never;
    rt.queuedPrompts.value = [dismissedCard()];

    handler({ type: "prompt_queue_cancelled", clientMessageId: "cmid-gone" });
    await settle();

    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.dismissedPromptIds?.has("cmid-gone")).toBe(true);
    expect(readDismissedOutbox().dismissed).toEqual(["cmid-gone"]);
    expect(sent).toEqual([]);
  });
});

// --- Interrupt cancels queue card --------------------------------------------

const INTERRUPT_OUTBOX_KEY = outboxStorageKey("session-interrupt", "main");
const ABORT_MESSAGE = "用户中断了请求";
const INTERRUPTED_PROMPT_ERROR =
  "Prompt execution was interrupted before completion. Retry explicitly to resume with incomplete-turn recovery.";

const mountInterruptHarness = () =>
  mountChatHarness({ sessionId: "session-interrupt", laneGeneration: 1 });

const readInterruptDismissed = (): string[] => {
  const raw = localStorage.getItem(INTERRUPT_OUTBOX_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { dismissed?: string[] };
  return parsed.dismissed ?? [];
};

describe("interrupting a turn cancels its queue card", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("drops the running card when the turn ends in a user abort", async () => {
    const { rt, handler } = mountInterruptHarness();
    rt.queuedPrompts.value = [runningCard()];

    handler({ type: "error", message: ABORT_MESSAGE, aborted: true });
    await settle();

    expect(rt.queuedPrompts.value).toHaveLength(0);
    expect(Array.from(rt.dismissedPromptIds ?? [])).toContain("cmid-abort");
    expect(readInterruptDismissed()).toContain("cmid-abort");
  });

  it("drops the running card when the abort only arrives as a queue failure", async () => {
    // The abort reaches the client as a prompt_queue row the server marked
    // failed. Without this the card parks above the composer forever, because
    // the lane only ever recovers rows that are still queued.
    const { rt, handler } = mountInterruptHarness();
    rt.queuedPrompts.value = [runningCard()];

    handler({
      type: "prompt_queue",
      entry: { clientMessageId: "cmid-abort", status: "failed", lastError: ABORT_MESSAGE },
    });
    await settle();

    expect(rt.queuedPrompts.value).toHaveLength(0);
    expect(readInterruptDismissed()).toContain("cmid-abort");
  });

  it.each(["prompt_queue", "prompt_queue_snapshot"] as const)(
    "drops an existing card for the canonical English interruption error from %s",
    async (type) => {
      const { rt, handler } = mountInterruptHarness();
      rt.queuedPrompts.value = [runningCard()];
      const entry = {
        clientMessageId: "cmid-abort",
        status: "failed",
        lastError: INTERRUPTED_PROMPT_ERROR,
      };

      handler(type === "prompt_queue" ? { type, entry } : { type, entries: [entry] });
      await settle();

      expect(rt.queuedPrompts.value).toHaveLength(0);
      expect(readInterruptDismissed()).toContain("cmid-abort");
    },
  );

  it.each(["prompt_queue", "prompt_queue_snapshot"] as const)(
    "does not rebuild a card for an unrendered canonical English interruption from %s",
    (type) => {
      const { rt, handler } = mountInterruptHarness();
      const entry = {
        clientMessageId: "cmid-abort",
        status: "failed",
        lastError: INTERRUPTED_PROMPT_ERROR,
      };

      handler(type === "prompt_queue" ? { type, entry } : { type, entries: [entry] });

      expect(rt.queuedPrompts.value).toHaveLength(0);
    },
  );

  it("does not rebuild a card for an aborted row that was never rendered", () => {
    const { rt, handler } = mountInterruptHarness();

    handler({
      type: "prompt_queue",
      entry: { clientMessageId: "cmid-abort", status: "failed", lastError: ABORT_MESSAGE },
    });

    expect(rt.queuedPrompts.value).toHaveLength(0);
  });

  it("keeps a genuine failure as a retryable card", () => {
    const { rt, handler } = mountInterruptHarness();

    handler({
      type: "prompt_queue",
      entry: { clientMessageId: "cmid-real", text: "retry this prompt", status: "failed", lastError: "provider connection reset" },
    });

    expect(rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId)).toEqual(["cmid-real"]);
    expect(rt.queuedPrompts.value[0]?.deliveryStatus).toBe("failed");
  });

  it("leaves the rest of the lane alone when the running prompt is aborted", () => {
    const { rt, handler } = mountInterruptHarness();
    rt.queuedPrompts.value = [
      runningCard(),
      runningCard({ id: "q-waiting", clientMessageId: "cmid-next", deliveryStatus: "queued" }),
    ];

    handler({ type: "error", message: ABORT_MESSAGE, aborted: true });

    expect(rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId)).toEqual(["cmid-next"]);
  });
});

// --- issue-379 failed queued prompt recovery ---------------------------------

const ISSUE_379_OUTBOX_KEY = outboxStorageKey("session-379", "main");

const mountRetryHarness = (overrides: Partial<ProjectRuntime> = {}) =>
  mountChatHarness({ sessionId: "session-379", ...overrides });

const failedServerCard = (overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: "q-failed",
  clientMessageId: "cmid-original",
  text: "resume the interrupted turn",
  images: [],
  createdAt: 1000,
  agentId: "claude",
  model: "auto",
  deliveryStatus: "failed",
  serverQueueTracked: true,
  queueLaneGeneration: 1,
  queueError: "Prompt execution was interrupted before completion.",
  ...overrides,
});

describe("issue-379 failed queued prompt recovery", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("replays a failed prompt under its original client id with incomplete-turn recovery", async () => {
    const { chat, rt, sentFrames } = mountRetryHarness();
    rt.queuedPrompts.value = [failedServerCard()];

    chat.retryQueuedPrompt("q-failed", rt);
    await settle();

    // The server keys the durable row by client id, so an explicit retry has to
    // reuse it: that is what requeues the row instead of inserting a duplicate.
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.clientMessageId).toBe("cmid-original");
    expect(sentFrames[0]?.payload).toMatchObject({
      text: "resume the interrupted turn",
      agentId: "claude",
      replay_incomplete: true,
    });
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBe("cmid-original");
  });

  it("re-keys a retry whose durable row belongs to an older lane generation", async () => {
    const { chat, rt, sentFrames } = mountRetryHarness({ laneGeneration: 2 });
    rt.queuedPrompts.value = [failedServerCard({ queueLaneGeneration: 1 })];

    chat.retryQueuedPrompt("q-failed", rt);
    await settle();

    // The client id is bound to the generation it was written under, so replaying
    // it into a reset lane would be rejected as a different prompt scope. Work
    // stranded by a reset has to be resubmitted under a fresh id instead.
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.clientMessageId).not.toBe("cmid-original");
    expect(String(sentFrames[0]?.clientMessageId ?? "")).not.toBe("");
    expect(sentFrames[0]?.payload).toMatchObject({ replay_incomplete: true });
  });

  it("keeps a retried prompt queued behind server-tracked work", async () => {
    const { chat, rt, sentFrames } = mountRetryHarness();
    rt.queuedPrompts.value = [
      failedServerCard({ id: "q-other", clientMessageId: "cmid-other", deliveryStatus: "queued", queueError: undefined }),
      failedServerCard(),
    ];

    chat.retryQueuedPrompt("q-failed", rt);
    await settle();

    expect(sentFrames.map((frame) => frame.clientMessageId)).toEqual(["cmid-original"]);
    expect(rt.queuedPrompts.value.map((entry) => entry.id)).toEqual(["q-other"]);
  });

  it("retires the stranded row when a cross-generation retry re-keys it", async () => {
    const { chat, rt, sentFrames, handler } = mountRetryHarness({ laneGeneration: 2 });
    rt.queuedPrompts.value = [failedServerCard({ queueLaneGeneration: 1 })];

    chat.retryQueuedPrompt("q-failed", rt);
    await settle();

    // The original row still exists on the server and stays in the logical-lane
    // snapshot, so leaving it visible would invite a second, duplicate retry.
    expect(Array.from(rt.dismissedPromptIds ?? [])).toEqual(["cmid-original"]);

    handler({
      type: "prompt_queue_snapshot",
      entries: [{
        clientMessageId: "cmid-original",
        text: "resume the interrupted turn",
        status: "failed",
        position: 0,
        attempts: 1,
        createdAt: 1000,
        updatedAt: 1000,
        lastError: "Prompt execution was interrupted before completion.",
        laneGeneration: 1,
      }],
    } as never);
    await settle();

    expect(rt.queuedPrompts.value.map((entry) => entry.clientMessageId)).not.toContain("cmid-original");
    expect(sentFrames).toHaveLength(1);
  });

  it("keeps a single card when a sibling broadcast repeats a tracked id", async () => {
    const { chat, rt } = mountRetryHarness();

    chat.enqueuePrompt("bind this tab", [], rt);
    await settle();

    rt.queuedPrompts.value = [
      ...rt.queuedPrompts.value,
      failedServerCard({ id: "server-cmid-1", clientMessageId: "cmid-server", deliveryStatus: "queued" }),
    ];
    expect(rt.queuedPrompts.value.filter((entry) => entry.clientMessageId === "cmid-server")).toHaveLength(1);

    // A second store on the same channel stands in for a sibling tab. A delayed
    // broadcast can still name an id this tab already tracks, and merging blindly
    // would render two cards for one prompt.
    const sibling = createOutboxStore({ channelName: OUTBOX_CHANNEL_NAME });
    sibling.write(ISSUE_379_OUTBOX_KEY, {
      pending: null,
      sent: [{ clientMessageId: "cmid-server", text: "stranded", createdAt: 1000 }],
      queued: [],
      dismissed: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(rt.queuedPrompts.value.filter((entry) => entry.clientMessageId === "cmid-server")).toHaveLength(1);
  });

  it("ignores retry for entries that are not in a failed state", async () => {
    const { chat, rt, sentFrames } = mountRetryHarness();
    rt.queuedPrompts.value = [failedServerCard({ id: "q-live", deliveryStatus: "queued" })];

    chat.retryQueuedPrompt("q-live", rt);
    chat.retryQueuedPrompt("missing-id", rt);
    await settle();

    expect(sentFrames).toHaveLength(0);
    expect(rt.queuedPrompts.value).toHaveLength(1);
  });

  it("keeps a removed server card removed across queue snapshots", async () => {
    const { chat, rt, handler } = mountRetryHarness();
    const snapshot = {
      type: "prompt_queue_snapshot",
      entries: [{
        clientMessageId: "cmid-original",
        text: "resume the interrupted turn",
        status: "failed",
        position: 0,
        attempts: 1,
        createdAt: 1000,
        updatedAt: 1000,
        lastError: "Prompt execution was interrupted before completion.",
        laneGeneration: 1,
      }],
    };

    handler(snapshot as never);
    await settle();
    expect(rt.queuedPrompts.value.map((entry) => entry.id)).toEqual(["server-cmid-original"]);

    chat.removeQueuedPrompt("server-cmid-original", rt);
    await settle();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(Array.from(rt.dismissedPromptIds ?? [])).toEqual(["cmid-original"]);

    // The durable row still exists server-side, so the snapshot would otherwise
    // resurrect the card the user just dismissed.
    handler(snapshot as never);
    await settle();
    expect(rt.queuedPrompts.value).toEqual([]);
  });

  it("keeps server-owned cards when a sibling tab broadcasts its outbox", async () => {
    const { chat: chatA, rt: rtA } = mountRetryHarness();
    const { chat: chatB, rt: rtB } = mountRetryHarness();

    // Both tabs share one outbox key, so both must bind before either writes.
    chatB.enqueuePrompt("from tab b", [], rtB);
    chatA.enqueuePrompt("from tab a", [], rtA);
    await settle();

    // Tab A also shows a card the server owns. The outbox deliberately omits
    // acknowledged server work, so it is absent from any broadcast snapshot.
    rtA.queuedPrompts.value = [
      ...rtA.queuedPrompts.value,
      failedServerCard({ id: "server-cmid-1", clientMessageId: "cmid-server", deliveryStatus: "queued" }),
    ];

    chatB.enqueuePrompt("second from tab b", [], rtB);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(rtA.queuedPrompts.value.map((entry) => entry.clientMessageId)).toContain("cmid-server");
  });

  it("restores dismissals written by a sibling tab", () => {
    const { rt: first } = mountRetryHarness();
    const { chat, rt: second } = mountRetryHarness();

    second.queuedPrompts.value = [failedServerCard()];
    chat.removeQueuedPrompt("q-failed", second);

    const stored = JSON.parse(localStorage.getItem(ISSUE_379_OUTBOX_KEY) ?? "{}") as { dismissed?: string[] };
    expect(stored.dismissed).toEqual(["cmid-original"]);

    first.queuedPrompts.value = [failedServerCard({ id: "server-cmid-original" })];
    chat.enqueuePrompt("unrelated", [], first);
    // The dismissal is restored when this tab binds its own outbox.
    expect(first.queuedPrompts.value.some((entry) => entry.clientMessageId === "cmid-original")).toBe(false);
  });
});

// --- Queue card resurrection after completion --------------------------------

const RESURRECTION_OUTBOX_KEY = outboxStorageKey("session-resurrection", "main");

const mountResurrectionHarness = (overrides: Partial<ProjectRuntime> = {}) =>
  mountChatHarness({ sessionId: "session-resurrection", ...overrides });

const sendPromptViaQueue = async (
  rt: ProjectRuntime,
  chat: ReturnType<typeof createChatActions>,
  text: string,
) => {
  chat.enqueuePrompt(text, [], rt);
  await settle();
  const bubble = rt.messages.value.find((message) => message.role === "user");
  expect(bubble).toBeDefined();
  return String(bubble?.id ?? "");
};

const queueEntry = (clientMessageId: string, status: string) => ({
  clientMessageId,
  status,
  position: 0,
  attempts: 1,
  createdAt: 1000,
  updatedAt: 1000,
  completedAt: status === "completed" ? 2000 : null,
  lastError: "",
  laneGeneration: 1,
});

const cardsFor = (rt: ProjectRuntime, clientMessageId: string) =>
  rt.queuedPrompts.value.filter((entry) => entry.clientMessageId === clientMessageId);

describe("a restored queue card does not survive the server reporting the prompt completed", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("drops the card and the durable outbox entry when the snapshot reports completed", async () => {
    const { chat, rt, handler } = mountResurrectionHarness();
    const clientMessageId = await sendPromptViaQueue(rt, chat, "sent before the deploy");

    // The acknowledgement never reached this tab, so the durable outbox still
    // holds the prompt and the next reconnect restores it as a card.
    chat.restorePendingPrompt(rt);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);

    handler({
      type: "prompt_queue_snapshot",
      entries: [queueEntry(clientMessageId, "completed")],
    } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
    expect(rt.consumedPromptIds?.has(clientMessageId)).toBe(true);
    expect(JSON.parse(localStorage.getItem(RESURRECTION_OUTBOX_KEY) ?? "{}").consumed).toEqual([clientMessageId]);
    // The consumed marker prevents a later reconnect from resurrecting it.
    chat.restorePendingPrompt(rt);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("marks a running prompt consumed before a stale queued snapshot can restore it", async () => {
    const { chat, rt, handler } = mountResurrectionHarness();
    const clientMessageId = await sendPromptViaQueue(rt, chat, "already picked up by the worker");

    chat.restorePendingPrompt(rt);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);

    handler({
      type: "prompt_queue_snapshot",
      entries: [queueEntry(clientMessageId, "running")],
    } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
    expect(rt.consumedPromptIds?.has(clientMessageId)).toBe(true);

    localStorage.setItem(RESURRECTION_OUTBOX_KEY, JSON.stringify({
      pending: null,
      sent: [],
      queued: [{ clientMessageId, text: "already picked up by the worker", createdAt: 1000 }],
      dismissed: [],
      consumed: [clientMessageId],
    }));
    chat.restorePendingPrompt(rt);

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("does not restore a queued entry already marked consumed", () => {
    const clientMessageId = "cmid-consumed-queued";
    localStorage.setItem(RESURRECTION_OUTBOX_KEY, JSON.stringify({
      pending: { clientMessageId, text: "already consumed", createdAt: 1000 },
      sent: [],
      queued: [{ clientMessageId, text: "already consumed", createdAt: 1000 }],
      dismissed: [],
      consumed: [clientMessageId],
    }));

    const { chat, rt } = mountResurrectionHarness();
    chat.restorePendingPrompt(rt);

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("keeps a card the snapshot still reports as live", async () => {
    const { chat, rt, handler } = mountResurrectionHarness();
    const clientMessageId = await sendPromptViaQueue(rt, chat, "still waiting its turn");

    chat.restorePendingPrompt(rt);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);

    handler({
      type: "prompt_queue_snapshot",
      entries: [queueEntry(clientMessageId, "queued")],
    } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
  });
});
