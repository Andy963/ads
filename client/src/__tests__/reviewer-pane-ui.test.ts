import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let lastReviewerWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
  onTaskEvent?: (payload: unknown) => void;
  onMessage?: (msg: unknown) => void;
  sendPrompt?: (payload: unknown, clientMessageId?: string) => void;
  clearHistory?: (payload?: unknown) => void;
} | null = null;
let lastReviewerPromptPayload: unknown = null;
let lastReviewerClearHistoryPayload: unknown = null;

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (!getImpl) throw new Error("getImpl not set");
      return (await getImpl(url)) as T;
    }

    async post<T>(): Promise<T> {
      throw new Error("not implemented");
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
    onTaskEvent?: (payload: unknown) => void;
    onMessage?: (msg: unknown) => void;
    send = vi.fn();

    constructor(options: { sessionId: string; chatSessionId?: string }) {
      const chatSessionId = String(options.chatSessionId ?? "main").trim() || "main";
      if (chatSessionId === "reviewer") {
        lastReviewerWs = this as unknown as typeof lastReviewerWs;
      }
    }

    connect(): void {}
    close(): void {}
    sendPrompt(payload: unknown): void {
      lastReviewerPromptPayload = payload;
    }
    interrupt(): void {}
    clearHistory(payload?: unknown): void {
      lastReviewerClearHistoryPayload = payload;
    }
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

describe("Reviewer pane UI", () => {
  beforeEach(() => {
    lastReviewerWs = null;
    lastReviewerPromptPayload = null;
    lastReviewerClearHistoryPayload = null;
    localStorage.clear();
    sessionStorage.clear();
    getImpl = async (url: string) => {
      if (url === "/api/models") {
        return [
          { id: "gpt-4.1", displayName: "GPT-4.1", provider: "openai", isEnabled: true, isDefault: true },
        ] satisfies ModelConfig[];
      }
      if (url.includes("/api/task-queue/status")) {
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      }
      if (url.startsWith("/api/review-artifacts")) {
        return {
          items: [
            {
              id: "artifact-123",
              taskId: "task-7",
              snapshotId: "snapshot-9",
              queueItemId: null,
              scope: "reviewer",
              summaryText: "Guard the null case before calling into the worker flow.",
              verdict: "analysis",
              priorArtifactId: null,
              createdAt: Date.now(),
            },
          ],
        };
      }
      if (url.startsWith("/api/tasks"))
        return [
          {
            id: "task-7",
            title: "Task 7",
            prompt: "Do work",
            model: "auto",
            status: "completed",
            priority: 0,
            queueOrder: 0,
            inheritContext: false,
            agentId: null,
            retryCount: 0,
            maxRetries: 3,
            reviewRequired: true,
            reviewStatus: "pending",
            reviewSnapshotId: "snapshot-9",
            createdAt: Date.now(),
          },
        ] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    lastReviewerWs = null;
    lastReviewerPromptPayload = null;
    lastReviewerClearHistoryPayload = null;
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("renders an interactive reviewer composer and surfaces the latest review artifact", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false, MainChatView: false, MainChatComposerPanel: false, MarkdownContent: true, DraggableModal: true } },
    });
    await settleUi(wrapper);

    expect(lastReviewerWs).toBeTruthy();
    lastReviewerWs!.onOpen?.();
    lastReviewerWs!.onMessage?.({ type: "welcome", inFlight: false, chatSessionId: "reviewer" });
    await settleUi(wrapper);

    await wrapper.get('[data-testid="lane-tab-reviewer"]').trigger("click");
    await settleUi(wrapper);

    await wrapper.get('[data-testid="reviewer-bind-selected-snapshot"]').trigger("click");
    await settleUi(wrapper);

    const textarea = wrapper.get('[data-testid="lane-panel-reviewer"] textarea.composer-input');
    await textarea.setValue("Please review the latest snapshot");
    expect((textarea.element as HTMLTextAreaElement).value).toBe("Please review the latest snapshot");

    (wrapper.vm as any).sendReviewerPrompt("Please review the latest snapshot");
    await settleUi(wrapper);
    expect(lastReviewerPromptPayload).toMatchObject({
      text: "Please review the latest snapshot",
      model: "gpt-4.1",
      snapshotId: "snapshot-9",
    });

    lastReviewerWs!.onMessage?.({
      type: "reviewer_artifact",
      artifact: {
        id: "artifact-123",
        taskId: "task-7",
        snapshotId: "snapshot-9",
        queueItemId: null,
        scope: "reviewer",
        summaryText: "Guard the null case before calling into the worker flow.",
        verdict: "analysis",
        priorArtifactId: null,
        createdAt: Date.now(),
      },
    });
    await settleUi(wrapper);

    const banner = wrapper.get('[data-testid="review-artifact-banner"]');
    expect(banner.text()).toContain("artifact-123");
    expect(banner.text()).toContain("snapshot-9");
    expect(banner.text()).toContain("Guard the null case before calling into the worker flow.");

    wrapper.unmount();
  });

  it("keeps the current snapshot binding when starting a new reviewer session", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false, MainChatView: false, MainChatComposerPanel: false, MarkdownContent: true, DraggableModal: true } },
    });
    await settleUi(wrapper);

    lastReviewerWs!.onOpen?.();
    lastReviewerWs!.onMessage?.({ type: "welcome", inFlight: false, chatSessionId: "reviewer" });
    await settleUi(wrapper);

    await wrapper.get('[data-testid="lane-tab-reviewer"]').trigger("click");
    await settleUi(wrapper);
    await wrapper.get('[data-testid="reviewer-bind-selected-snapshot"]').trigger("click");
    await settleUi(wrapper);

    await wrapper.get('[data-testid="lane-new-session"]').trigger("click");
    await settleUi(wrapper);
    expect(lastReviewerClearHistoryPayload).toEqual({ preserveReviewerSnapshotId: "snapshot-9" });

    (wrapper.vm as any).sendReviewerPrompt("Review again");
    await settleUi(wrapper);
    expect(lastReviewerPromptPayload).toMatchObject({
      text: "Review again",
      snapshotId: "snapshot-9",
    });

    wrapper.unmount();
  });

  it("blocks reviewer binding mutations while disconnected", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false, MainChatView: false, MainChatComposerPanel: false, MarkdownContent: true, DraggableModal: true } },
    });
    await settleUi(wrapper);

    lastReviewerWs!.onOpen?.();
    lastReviewerWs!.onMessage?.({ type: "welcome", inFlight: false, chatSessionId: "reviewer" });
    await settleUi(wrapper);

    await wrapper.get('[data-testid="lane-tab-reviewer"]').trigger("click");
    await settleUi(wrapper);

    const reviewerRt = (wrapper.vm as any).activeReviewerRuntime;
    reviewerRt.messages.value = [
      { id: "u-1", role: "user", kind: "text", content: "Please review snapshot-old" },
      { id: "a-1", role: "assistant", kind: "text", content: "Existing reviewer continuity" },
    ];
    reviewerRt.activeThreadId.value = "reviewer-thread-old";
    reviewerRt.boundReviewSnapshotId.value = "snapshot-old";
    reviewerRt.latestReviewArtifact.value = {
      id: "artifact-old",
      taskId: "task-7",
      snapshotId: "snapshot-old",
      queueItemId: null,
      scope: "reviewer",
      summaryText: "Old artifact",
      verdict: "analysis",
      priorArtifactId: null,
      createdAt: Date.now(),
    };
    await settleUi(wrapper);

    lastReviewerWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    expect((wrapper.get('[data-testid="reviewer-bind-selected-snapshot"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.get('[data-testid="reviewer-clear-snapshot-binding"]').element as HTMLButtonElement).disabled).toBe(true);

    await (wrapper.vm as any).bindReviewerToSelectedSnapshot();
    await settleUi(wrapper);
    (wrapper.vm as any).clearReviewerSnapshotBinding();
    await settleUi(wrapper);

    expect(reviewerRt.boundReviewSnapshotId.value).toBe("snapshot-old");
    expect(reviewerRt.latestReviewArtifact.value).toEqual({
      id: "artifact-old",
      taskId: "task-7",
      snapshotId: "snapshot-old",
      queueItemId: null,
      scope: "reviewer",
      summaryText: "Old artifact",
      verdict: "analysis",
      priorArtifactId: null,
      createdAt: expect.any(Number),
    });
    expect(reviewerRt.activeThreadId.value).toBe("reviewer-thread-old");
    expect(reviewerRt.messages.value.map((m: any) => String(m.content ?? ""))).toEqual([
      "Please review snapshot-old",
      "Existing reviewer continuity",
    ]);
    expect(lastReviewerClearHistoryPayload).toBeNull();

    wrapper.unmount();
  });

  it("clears stale reviewer transcript when bootstrap explicitly withholds reviewer continuity", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false, MainChatView: false, MainChatComposerPanel: false, MarkdownContent: true, DraggableModal: true } },
    });
    await settleUi(wrapper);

    lastReviewerWs!.onOpen?.();
    lastReviewerWs!.onMessage?.({ type: "welcome", inFlight: false, chatSessionId: "reviewer" });
    await settleUi(wrapper);

    const reviewerRt = (wrapper.vm as any).activeReviewerRuntime;
    expect(reviewerRt?.messages?.value).toBeTruthy();
    reviewerRt.messages.value = [
      { id: "u-1", role: "user", kind: "text", content: "Please review snapshot-9" },
      { id: "a-1", role: "assistant", kind: "text", content: "Previous reviewer transcript" },
    ];
    reviewerRt.activeThreadId.value = "reviewer-thread-old";
    reviewerRt.boundReviewSnapshotId.value = "snapshot-9";
    reviewerRt.latestReviewArtifact.value = {
      id: "artifact-123",
      taskId: "task-7",
      snapshotId: "snapshot-9",
      queueItemId: null,
      scope: "reviewer",
      summaryText: "Guard the null case before calling into the worker flow.",
      verdict: "analysis",
      priorArtifactId: null,
      createdAt: Date.now(),
    };
    await settleUi(wrapper);

    expect((wrapper.vm as any).reviewerBoundSnapshotId).toBe("snapshot-9");
    expect((wrapper.vm as any).reviewerLatestArtifact?.id).toBe("artifact-123");

    lastReviewerWs!.onMessage?.({ type: "reviewer_snapshot_binding", snapshotId: null });
    await settleUi(wrapper);

    expect((wrapper.vm as any).reviewerBoundSnapshotId).toBeNull();
    expect((wrapper.vm as any).reviewerLatestArtifact).toBeNull();
    expect(reviewerRt.activeThreadId.value).toBeNull();
    const contents = reviewerRt.messages.value.map((m: any) => String(m.content ?? ""));
    expect(contents.join("\n")).not.toContain("Please review snapshot-9");
    expect(contents.join("\n")).not.toContain("Previous reviewer transcript");
    expect(contents.join("\n")).toContain("Reviewer continuity was unavailable from the backend.");
    expect(wrapper.find('[data-testid="review-artifact-banner"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("shows a lane-local reviewer connection indicator after websocket errors", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false, MainChatView: false, MainChatComposerPanel: false, MarkdownContent: true, DraggableModal: true } },
    });
    await settleUi(wrapper);

    lastReviewerWs!.onOpen?.();
    lastReviewerWs!.onMessage?.({ type: "welcome", inFlight: false, chatSessionId: "reviewer" });
    await settleUi(wrapper);

    await wrapper.get('[data-testid="lane-tab-reviewer"]').trigger("click");
    await settleUi(wrapper);

    lastReviewerWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    const status = wrapper.get('[data-testid="lane-panel-reviewer"] [data-testid="lane-connection-status"]');
    expect(status.text()).toContain("WebSocket closed (1006)");

    wrapper.unmount();
  });
});
