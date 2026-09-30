import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import { collectCommandActivityFrames, commandActivityCases, commandCommentary, commandFinalReply } from "../../../tests/web/commandActivityHarness";
import type { ChatMessage } from "../components/mainChat/types";
import MainChatMessageList from "../components/MainChatMessageList.vue";
import { loadMarkdown } from "../lib/markdown/loader";

let lastWs: { onOpen?: () => void; onMessage?: (frame: unknown) => void } | null = null;

vi.mock("../api/client", () => ({
  ApiClient: class {
    async get(url: string) {
      if (url === "/api/models") return [];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    }
  },
}));

vi.mock("../api/ws", () => ({
  AdsWebSocket: class {
    onOpen?: () => void;
    onMessage?: (frame: unknown) => void;
    constructor(options: { chatSessionId?: string }) {
      if (options.chatSessionId !== "acopilot") lastWs = this as NonNullable<typeof lastWs>;
    }
    connect() {}
    close() {}
    send() {}
    sendPrompt() {}
    interrupt() {}
  },
}));

vi.mock("../components/LoginGate.vue", () => ({
  default: defineComponent({
    emits: ["logged-in"],
    mounted() { this.$emit("logged-in", { id: "test-user", username: "test" }); },
    template: "<div />",
  }),
}));

afterEach(() => { lastWs = null; });

describe("command activity origin rendering", () => {
  it("renders actual native bridge frames only as commands while retaining non-command activity and commentary", async () => {
    // No live provider or application server: only the Native fetch boundary and browser transport are replaced.
    const { frames, entries, commandFrameCount } = await collectCommandActivityFrames();
    expect(entries.slice(0, commandActivityCases.length).map((entry) => entry.category))
      .toEqual(commandActivityCases.map((command) => command.category));
    localStorage.clear();
    sessionStorage.clear();
    await loadMarkdown();
    const App = (await import("../App.vue")).default;
    const app = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    const list = mount(MainChatMessageList, {
      global: { stubs: { MarkdownContent: false } },
      props: {
        messages: [], copiedMessageId: null, formatMessageTs: () => "",
        liveStepExpanded: false, liveStepHasOverflow: false, liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [], liveStepOutlineHiddenCount: 0, liveStepCollapsedTrivialOutline: false,
      },
    });
    const controller = app.vm as unknown as {
      connectWs: () => Promise<void>;
      sendMainPrompt: (text: string) => void;
      messages: ChatMessage[];
    };
    try {
      await flushPromises();
      if (!lastWs) await controller.connectWs();
      expect(lastWs).toBeTruthy();
      lastWs!.onOpen?.();
      controller.sendMainPrompt("Inspect the fixture");
      await flushPromises();

      const renderedCommands: string[] = [];
      for (const [index, frame] of frames.entries()) {
        lastWs!.onMessage?.(frame);
        await flushPromises();
        await list.setProps({ messages: controller.messages });
        if (index < commandFrameCount) {
          expect(controller.messages.some((message) => message.id === "live-activity")).toBe(false);
          expect(list.findAll('.msg[data-role="assistant"] strong')).toHaveLength(0);
        }
        if (frame.type === "command") {
          expect(list.findAll(".execute-block")).toHaveLength(1);
          expect(list.get(".execute-cmd").text()).toBe(frame.command!.command);
          expect(list.get(".execute-block").classes().includes("execute-block--running"))
            .toBe(frame.command!.status === "in_progress");
          if (frame.command!.status === "in_progress") renderedCommands.push(frame.command!.command);
        }
        if (frame.type === "explored") {
          expect(controller.messages.some((message) => message.id === "live-activity")).toBe(true);
          expect(list.findAll("strong").map((node) => node.text()))
            .toContain(`${frame.entry!.category === "WebSearch" ? "Web search" : frame.entry!.category}: ${frame.entry!.summary}`);
        }
      }
      expect(renderedCommands).toEqual(commandActivityCases.map(({ cmd, args }) => [cmd, ...args].join(" ")));
      expect(list.text()).toContain(commandCommentary);
      expect(list.text()).toContain(commandFinalReply);
      expect(list.findAll("strong")).toHaveLength(5);
      for (const entry of entries.slice(0, commandActivityCases.length)) {
        expect(list.findAll("strong").map((node) => node.text())).not.toContain(`${entry.category}: ${entry.summary}`);
      }
    } finally {
      list.unmount();
      app.unmount();
    }
  });
});
