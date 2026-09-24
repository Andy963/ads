import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

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

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

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

  it("renders queue depth badge and start button when a task is queued, and triggers /api/actions/queue/start on click", async () => {
    const mockJobs = [
      {
        id: "job-1",
        project_id: "/home/andy/repos/ads",
        issue_id: 341,
        issue_title: "Implement manual start button",
        status: "queued",
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        id: "job-2",
        project_id: "/home/andy/repos/ads",
        issue_id: 342,
        issue_title: "Second queued task",
        status: "queued",
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

    const queueBadge = wrapper.find('[data-testid="actions-queue-count-badge"]');
    expect(queueBadge.exists()).toBe(true);
    expect(queueBadge.text()).toContain("队列中 2 个任务");

    const startBtn = wrapper.find('[data-testid="btn-action-start"]');
    expect(startBtn.exists()).toBe(true);
    expect(startBtn.text()).toContain("启动执行");

    // Click start button and verify API invocation
    await startBtn.trigger("click");
    await settleUi(wrapper);

    expect(postSpy).toHaveBeenCalledWith("/api/actions/queue/start", expect.objectContaining({
      projectId: expect.any(String),
      repoPath: "/home/andy/repos/ads",
    }));

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
    // The running task title should be displayed, not the queued task
    expect(banner.text()).toContain("Older Running Task");

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

  it("shows a blocked job with rework details and prevents the queue from advancing", async () => {
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
    expect(banner.text()).toContain("Recover Actions reliability");
    expect(banner.text()).toContain("Rework 2/2");
    expect(banner.text()).toContain("PR creation failed twice");

    await (wrapper.vm as any).triggerStartActionQueue();
    await settleUi(wrapper);
    expect(postSpy).not.toHaveBeenCalled();
    expect((wrapper.vm as any).apiNotice).toContain("PR creation failed twice");

    wrapper.unmount();
  });
});
