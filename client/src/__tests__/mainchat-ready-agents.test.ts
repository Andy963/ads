import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatModelPopover from "../components/MainChatModelPopover.vue";

describe("MainChat ready agents", () => {
  const baseProps = {
    connected: true,
    busy: false,
  } as const;

  it("hides the agent selector and auto-switches when the active agent is not ready", async () => {
    const wrapper = mount(MainChatModelPopover, {
      props: {
        ...baseProps,
        agents: [
          { id: "codex", name: "Codex", ready: false, error: "missing api key" },
          { id: "claude", name: "Claude", ready: true },
        ],
        activeAgentId: "codex",
        models: [],
        modelId: "auto",
      },
    });

    await wrapper.vm.$nextTick();

    const agentSelect = wrapper.find('select[aria-label="Select agent"]');
    expect(agentSelect.exists()).toBe(false);

    expect(wrapper.emitted("switchAgent")?.[0]?.[0]).toBe("claude");
    expect(wrapper.emitted("switchAgent")?.length).toBe(1);

    wrapper.unmount();
  });
});
