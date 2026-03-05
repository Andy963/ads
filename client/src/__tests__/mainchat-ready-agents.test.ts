import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

describe("MainChat ready agents", () => {
  const baseProps = {
    messages: [],
    queuedPrompts: [],
    pendingImages: [],
    connected: true,
    busy: false,
  } as const;

  it("renders only ready agents and auto-switches when the active agent is not ready", async () => {
    const wrapper = mount(MainChat, {
      props: {
        ...baseProps,
        agents: [
          { id: "codex", name: "Codex", ready: false, error: "missing api key" },
          { id: "claude", name: "Claude", ready: true },
          { id: "gemini", name: "Gemini", ready: true },
        ],
        activeAgentId: "codex",
        models: [],
        modelId: "auto",
      },
      global: { stubs: { MarkdownContent: true, DraggableModal: true } },
    });

    await wrapper.vm.$nextTick();

    const agentSelect = wrapper.find('select[aria-label="Select agent"]');
    expect(agentSelect.exists()).toBe(true);
    expect((agentSelect.element as HTMLSelectElement).value).toBe("claude");

    const values = agentSelect.findAll("option").map((opt) => opt.attributes("value"));
    expect(values).toEqual(["claude", "gemini"]);

    expect(wrapper.emitted("switchAgent")?.[0]?.[0]).toBe("claude");
    expect(wrapper.emitted("switchAgent")?.length).toBe(1);

    wrapper.unmount();
  });
});

