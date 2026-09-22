import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig } from "../api/types";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, relFromThisFile), "utf8");
}

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;

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
    onMessage?: (msg: unknown) => void;

    constructor(_: { sessionId: string; chatSessionId?: string }) {}

    connect(): void {}
    close(): void {}

    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
    clearHistory(): void {}
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

describe("project status spinner", () => {
  beforeEach(() => {
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    vi.clearAllMocks();
  });

  it("shows lane-specific and combined project activity states", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    const pid = String((wrapper.vm as any).activeProjectId ?? "").trim();
    expect(pid).not.toBe("");

    const workerRuntime = (wrapper.vm as any).getRuntime(pid) as { busy: { value: boolean } };
    const advisorRuntime = (wrapper.vm as any).getAdvisorRuntime(pid) as { busy: { value: boolean } };
    workerRuntime.busy.value = false;
    advisorRuntime.busy.value = false;
    await settleUi(wrapper);

    expect(wrapper.find(".projectStatus").classes("spinning")).toBe(false);
    expect(wrapper.find('[data-testid="lane-tab-status-advisor"]').classes("laneTabStatusDot--busy-advisor")).toBe(false);
    expect(wrapper.find('[data-testid="lane-tab-status-worker"]').classes("laneTabStatusDot--busy-worker")).toBe(false);

    advisorRuntime.busy.value = true;
    await settleUi(wrapper);
    const projectStatus = wrapper.find(".projectStatus");
    expect(projectStatus.classes()).toEqual(expect.arrayContaining(["spinning", "spinning--advisor"]));
    expect(projectStatus.attributes("title")).toBe("Advisor 正在规划…");
    expect(wrapper.find('[data-testid="lane-tab-status-advisor"]').classes()).toContain("laneTabStatusDot--busy-advisor");
    expect(wrapper.find('[data-testid="lane-tab-status-worker"]').classes("laneTabStatusDot--busy-worker")).toBe(false);

    workerRuntime.busy.value = true;
    await settleUi(wrapper);
    expect(projectStatus.classes()).toEqual(expect.arrayContaining(["spinning", "spinning--both"]));
    expect(projectStatus.attributes("title")).toBe("Advisor 与 Worker 均在运行中…");
    expect(wrapper.find('[data-testid="lane-tab-status-worker"]').classes()).toContain("laneTabStatusDot--busy-worker");

    advisorRuntime.busy.value = false;
    await settleUi(wrapper);
    expect(projectStatus.classes()).toEqual(expect.arrayContaining(["spinning", "spinning--worker"]));
    expect(projectStatus.classes("spinning--advisor")).toBe(false);
    expect(projectStatus.attributes("title")).toBe("Worker 正在执行…");

    workerRuntime.busy.value = false;
    await settleUi(wrapper);
    expect(projectStatus.classes("spinning")).toBe(false);
    expect(projectStatus.attributes("title")).toBeUndefined();

    wrapper.unmount();
  });

  it("uses pulsing breathing animation for busy lane dots", () => {
    const css = readUtf8("../App.css");
    const advisorDot = css.match(/\.laneTabStatusDot--busy-advisor\s*\{[^}]*\}/)?.[0];
    const workerDot = css.match(/\.laneTabStatusDot--busy-worker\s*\{[^}]*\}/)?.[0];

    expect(advisorDot).toBeDefined();
    expect(advisorDot).toMatch(/background:\s*#a855f7\s*;/);
    expect(advisorDot).toMatch(/animation:\s*laneDotPulse 1\.6s ease-in-out infinite\s*;/);

    expect(workerDot).toBeDefined();
    expect(workerDot).toMatch(/background:\s*#10b981\s*;/);
    expect(workerDot).toMatch(/animation:\s*laneDotPulse 1\.6s ease-in-out infinite\s*;/);

    expect(css).toMatch(/@keyframes\s+laneDotPulse\s*\{/);
  });
});
