import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import type { Component } from "vue";

import { lazyComponent } from "./asyncComponent";

function mountLazy(lazy: Component) {
  const host = defineComponent({ setup: () => () => h("section", [h(lazy)]) });
  return mount(host);
}

describe("lazyComponent", () => {
  it("loads the component on demand", async () => {
    const Inner = defineComponent({ name: "Inner", setup: () => () => h("p", "loaded") });
    const Lazy = lazyComponent(() => Promise.resolve(Inner));
    const wrapper = mountLazy(Lazy);
    await flushPromises();
    expect(wrapper.text()).toBe("loaded");
    wrapper.unmount();
  });

  it("retries a failed chunk load once before giving up", async () => {
    let calls = 0;
    const Inner = defineComponent({ name: "Inner", setup: () => () => h("p", "recovered") });
    const Lazy = lazyComponent(() => (++calls === 1 ? Promise.reject(new Error("chunk gone")) : Promise.resolve(Inner)));
    const wrapper = mountLazy(Lazy);
    await flushPromises();
    await flushPromises();
    expect(calls).toBe(2);
    expect(wrapper.text()).toBe("recovered");
    wrapper.unmount();
  });

  it("shows a reload prompt when the chunk keeps failing", async () => {
    const Lazy = lazyComponent(() => Promise.reject(new Error("missing chunk")));
    const wrapper = mountLazy(Lazy);
    await flushPromises();
    await flushPromises();
    expect(wrapper.text()).toContain("内容加载失败");
    expect(wrapper.get("button.lazyChunkErrorReload").text()).toBe("刷新");
    wrapper.unmount();
  });
});
