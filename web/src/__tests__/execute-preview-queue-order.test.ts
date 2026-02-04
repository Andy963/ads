import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { mount } from "@vue/test-utils";

import { createExecuteActions } from "../app/chatExecute";
import MainChat from "../components/MainChat.vue";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("execute preview queue ordering", () => {
  it("keeps insertion order stable even when older commands receive later output, and renders only the newest", async () => {
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
      findFirstLiveIndex: () => -1,
      findLastLiveIndex: () => -1,
    });

    upsertExecuteBlock("k1", "cmd-1", "$ cmd-1\nout-1\n", rt);
    upsertExecuteBlock("k2", "cmd-2", "$ cmd-2\nout-2\n", rt);
    upsertExecuteBlock("k3", "cmd-3", "$ cmd-3\nout-3\n", rt);
    upsertExecuteBlock("k4", "cmd-4", "$ cmd-4\nout-4\n", rt);

    upsertExecuteBlock("k2", "cmd-2", "tail-2\n", rt);

    const executeMessages = rt.messages.value.filter((m: any) => m.kind === "execute");
    expect(executeMessages.map((m: any) => m.command)).toEqual(["cmd-1", "cmd-2", "cmd-3", "cmd-4"]);

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
    const topCmd = wrapper.find(".execute-cmd");
    expect(topCmd.text()).toContain("cmd-4");

    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);

    wrapper.unmount();
  });
});
