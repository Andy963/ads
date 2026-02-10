import { describe, expect, it, vi } from "vitest";
import { mount, shallowMount } from "@vue/test-utils";

vi.mock("../api/client", () => {
  class ApiClient {
    async get(path: string): Promise<unknown> {
      if (path === "/api/auth/status") return { initialized: true };
      if (path === "/api/auth/me") throw new Error("unauthorized");
      throw new Error(`unexpected GET ${path}`);
    }

    async post(): Promise<unknown> {
      throw new Error("not implemented");
    }
  }

  return { ApiClient };
});

import LoginGate from "../components/LoginGate.vue";
import PromptsModal from "../components/PromptsModal.vue";
import TaskBoard from "../components/TaskBoard.vue";

function nextTickDelay(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

async function waitForLoginForm(wrapper: ReturnType<typeof mount>): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const username = wrapper.find('[data-testid="login-username"]');
    const password = wrapper.find('[data-testid="login-password"]');
    const submit = wrapper.find('[data-testid="login-submit"]');
    if (username.exists() && password.exists() && submit.exists()) return;
    await nextTickDelay();
    await wrapper.vm.$nextTick();
  }
  throw new Error("login form not rendered");
}

describe("UI smoke selectors", () => {
  it("exposes stable selectors for task create entry", () => {
    const wrapper = shallowMount(TaskBoard, {
      props: {
        tasks: [],
        agents: [],
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set(),
      },
    });

    expect(wrapper.find('[data-testid="task-board-create"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("exposes stable selectors for prompts library actions", () => {
    const wrapper = shallowMount(PromptsModal, { props: { prompts: [], busy: false, error: null } });

    expect(wrapper.find('[data-testid="prompts-new"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="prompts-name"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="prompts-content"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="prompts-save"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="prompts-delete"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("exposes stable selectors for login flow", async () => {
    const wrapper = mount(LoginGate, { attachTo: document.body });
    try {
      await waitForLoginForm(wrapper);
      expect(wrapper.find('[data-testid="login-username"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="login-password"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="login-submit"]').exists()).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });
});
