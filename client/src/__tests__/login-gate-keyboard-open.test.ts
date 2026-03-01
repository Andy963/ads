import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => {
  class ApiClient {
    async get(path: string): Promise<unknown> {
      if (path === "/api/auth/status") return { initialized: true };
      if (path === "/api/auth/me") throw new Error("unauthorized");
      throw new Error(`unexpected GET ${path}`);
    }

    async post(path: string): Promise<unknown> {
      if (path === "/api/auth/login") return { success: true };
      throw new Error(`unexpected POST ${path}`);
    }
  }

  return { ApiClient };
});

import LoginGate from "../components/LoginGate.vue";

function nextTickDelay(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

async function waitForLoginInputs(wrapper: ReturnType<typeof mount>): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (wrapper.findAll("input").length >= 2) return;
    await nextTickDelay();
    await wrapper.vm.$nextTick();
  }
  throw new Error("inputs not rendered");
}

describe("LoginGate keyboard-open class", () => {
  it("adds and removes keyboard-open on focus changes", async () => {
    const wrapper = mount(LoginGate, { attachTo: document.body });
    try {
      await waitForLoginInputs(wrapper);

      const inputs = wrapper.findAll("input");
      expect(wrapper.classes()).toContain("gate");
      expect(wrapper.classes()).not.toContain("keyboard-open");

      (inputs[0].element as HTMLInputElement).focus();
      await inputs[0].trigger("focusin");
      await wrapper.vm.$nextTick();
      expect(wrapper.classes()).toContain("keyboard-open");

      (inputs[0].element as HTMLInputElement).blur();
      await inputs[0].trigger("focusout");
      await nextTickDelay();
      await wrapper.vm.$nextTick();
      expect(wrapper.classes()).not.toContain("keyboard-open");
    } finally {
      wrapper.unmount();
    }
  });

  it("keeps keyboard-open when switching focus between inputs", async () => {
    const wrapper = mount(LoginGate, { attachTo: document.body });
    try {
      await waitForLoginInputs(wrapper);

      const inputs = wrapper.findAll("input");
      (inputs[0].element as HTMLInputElement).focus();
      await inputs[0].trigger("focusin");
      await wrapper.vm.$nextTick();
      expect(wrapper.classes()).toContain("keyboard-open");

      (inputs[1].element as HTMLInputElement).focus();
      await inputs[1].trigger("focusin");
      await wrapper.vm.$nextTick();
      expect(wrapper.classes()).toContain("keyboard-open");

      (inputs[1].element as HTMLInputElement).blur();
      await inputs[1].trigger("focusout");
      await nextTickDelay();
      await wrapper.vm.$nextTick();
      expect(wrapper.classes()).not.toContain("keyboard-open");
    } finally {
      wrapper.unmount();
    }
  });
});

