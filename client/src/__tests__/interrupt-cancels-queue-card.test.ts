import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";
import { createAppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import type { ProjectRuntime, QueuedPrompt } from "../app/controller";

const OUTBOX_KEY = "ads.outbox.session-1.main";
const ABORT_MESSAGE = "\u7528\u6237\u4e2d\u65ad\u4e86\u8bf7\u6c42";

const mountHarness = () => {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as never);
  const rt = ctx.activeRuntime.value as ProjectRuntime;
  rt.projectSessionId = "session-1";
  rt.chatSessionId = "main";
  rt.connected.value = true;
  rt.inputLocked.value = false;
  rt.laneGeneration = 1;
  rt.ws = { sendPrompt: () => true, send: () => true, clearHistory: () => {} } as never;
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
  return { chat, rt, handler };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

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

const readDismissed = (): string[] => {
  const raw = localStorage.getItem(OUTBOX_KEY);
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
    const { rt, handler } = mountHarness();
    rt.queuedPrompts.value = [runningCard()];

    handler({ type: "error", message: ABORT_MESSAGE, aborted: true });
    await settle();

    expect(rt.queuedPrompts.value).toHaveLength(0);
    expect(Array.from(rt.dismissedPromptIds ?? [])).toContain("cmid-abort");
    expect(readDismissed()).toContain("cmid-abort");
  });

  it("drops the running card when the abort only arrives as a queue failure", async () => {
    // The abort reaches the client as a prompt_queue row the server marked
    // failed. Without this the card parks above the composer forever, because
    // the lane only ever recovers rows that are still queued.
    const { rt, handler } = mountHarness();
    rt.queuedPrompts.value = [runningCard()];

    handler({
      type: "prompt_queue",
      entry: { clientMessageId: "cmid-abort", status: "failed", lastError: ABORT_MESSAGE },
    });
    await settle();

    expect(rt.queuedPrompts.value).toHaveLength(0);
    expect(readDismissed()).toContain("cmid-abort");
  });

  it("does not rebuild a card for an aborted row that was never rendered", () => {
    const { rt, handler } = mountHarness();

    handler({
      type: "prompt_queue",
      entry: { clientMessageId: "cmid-abort", status: "failed", lastError: ABORT_MESSAGE },
    });

    expect(rt.queuedPrompts.value).toHaveLength(0);
  });

  it("keeps a genuine failure as a retryable card", () => {
    const { rt, handler } = mountHarness();

    handler({
      type: "prompt_queue",
      entry: { clientMessageId: "cmid-real", text: "retry this prompt", status: "failed", lastError: "provider connection reset" },
    });

    expect(rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId)).toEqual(["cmid-real"]);
    expect(rt.queuedPrompts.value[0]?.deliveryStatus).toBe("failed");
  });

  it("leaves the rest of the lane alone when the running prompt is aborted", () => {
    const { rt, handler } = mountHarness();
    rt.queuedPrompts.value = [
      runningCard(),
      runningCard({ id: "q-waiting", clientMessageId: "cmid-next", deliveryStatus: "queued" }),
    ];

    handler({ type: "error", message: ABORT_MESSAGE, aborted: true });

    expect(rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId)).toEqual(["cmid-next"]);
  });
});

const Host = defineComponent({
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
      const wrapper = mount(Host, { attachTo: document.body });
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
