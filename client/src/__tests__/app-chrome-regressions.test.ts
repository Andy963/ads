import { readFile } from "node:fs/promises";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, shallowMount } from "@vue/test-utils";
import { defineComponent, h, type Component } from "vue";

import type { ModelConfig } from "../api/types";
import { readSfc } from "./readSfc";

type GetImpl = (url: string) => Promise<unknown>;
type PostImpl = (url: string, body: unknown) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let postImpl: PostImpl | null = null;
const wsSessionIds: string[] = [];

// Most suites stub LoginGate with an auto-login component; the LoginGate
// suite flips this to "real" so the actual component is rendered.
let loginGateMode: "auto-login" | "real" = "auto-login";
// The source suites disagreed on emit timing: composer draft isolation needs a
// synchronous logged-in emit during mount, the others expect a microtask.
let loginGateEmitSync = false;

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (!getImpl) throw new Error("getImpl not set");
      return (await getImpl(url)) as T;
    }

    async post<T>(url: string, body: unknown): Promise<T> {
      if (!postImpl) throw new Error("postImpl not set");
      return (await postImpl(url, body)) as T;
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

    constructor(options: { sessionId: string; chatSessionId?: string; resume?: unknown }) {
      wsSessionIds.push(String(options.sessionId));
    }

    connect(): void {
      queueMicrotask(() => this.onOpen?.());
    }

    close(): void {}
    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
    clearHistory(): void {}
    cancelPrompt(): void {}
  }

  return { AdsWebSocket };
});

vi.mock("../components/LoginGate.vue", async (importOriginal) => {
  const actual = await importOriginal<{ default: Component }>();
  return {
    default: defineComponent({
      name: "LoginGate",
      emits: ["logged-in"],
      mounted() {
        if (loginGateMode !== "auto-login") return;
        if (loginGateEmitSync) {
          this.$emit("logged-in", { id: "u-1", username: "admin" });
          return;
        }
        queueMicrotask(() => {
          this.$emit("logged-in", { id: "u-1", username: "admin" });
        });
      },
      render() {
        if (loginGateMode === "real") return h(actual.default);
        return h("div");
      },
    }),
  };
});

import LoginGate from "../components/LoginGate.vue";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await wrapper.vm.$nextTick();
    await Promise.resolve();
  }
}

async function mountApp(stubs: Record<string, boolean> = {}) {
  const App = (await import("../App.vue")).default;
  const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false, ...stubs } } });
  await settleUi(wrapper);
  return wrapper;
}

function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function idsFromVm(wrapper: { vm: { projects: Array<{ id: string }> } }): string[] {
  return wrapper.vm.projects.map((p) => p.id);
}

async function readClientFile(relativeToThisTest: string): Promise<string> {
  const url = new URL(relativeToThisTest, import.meta.url);
  return readFile(url, "utf8");
}

function getLaneTextarea(wrapper: any, lane: "acopilot" | "actions"): any {
  return wrapper.get(`[data-testid="lane-panel-${lane}"] textarea.composer-input`);
}

async function switchLane(wrapper: any, lane: "acopilot" | "actions"): Promise<void> {
  await wrapper.get(`[data-testid="lane-tab-${lane}"]`).trigger("click");
  await settleUi(wrapper);
}

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

function defaultGetImpl(url: string): Promise<unknown> {
  if (url === "/api/models") return Promise.resolve([] satisfies ModelConfig[]);
  if (url.startsWith("/api/paths/validate")) return Promise.resolve({ ok: false });
  return Promise.resolve({});
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  loginGateMode = "auto-login";
  loginGateEmitSync = false;
  wsSessionIds.length = 0;
  getImpl = defaultGetImpl;
  postImpl = async () => {
    throw new Error("postImpl not overridden");
  };
});

afterEach(() => {
  getImpl = null;
  postImpl = null;
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe("app bootstrap preserves the visible active project", () => {
  beforeEach(() => {
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "p1", path: "/tmp/project-a", name: "Project A", initialized: true, chatSessionId: "main" },
        { sessionId: "p2", path: "/tmp/project-b", name: "Project B", initialized: true, chatSessionId: "main" },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "p2");

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/paths/subdirs") {
        return { dirs: ["project-a", "project-b"], allowedDirs: ["/tmp"] };
      }
      if (url === "/api/projects") {
        return {
          projects: [
            { id: "p1", workspaceRoot: "/tmp/project-a", name: "Project A", chatSessionId: "main", createdAt: 1, updatedAt: 1 },
            { id: "p2", workspaceRoot: "/tmp/project-b", name: "Project B", chatSessionId: "main", createdAt: 2, updatedAt: 2 },
          ],
          activeProjectId: "p1",
        };
      }
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  it("does not switch to the server active project when the current local project is still present", async () => {
    const wrapper = await mountApp();

    expect((wrapper.vm as any).activeProjectId).toBe("p2");
    const appState = JSON.parse(localStorage.getItem("ads.app_state") ?? "{}") as { activeProject?: string };
    expect(appState.activeProject).toBe("p2");
    expect(localStorage.getItem("ADS_WEB_ACTIVE_PROJECT")).toBeNull();

    wrapper.unmount();
  });
});

describe("app brand version display", () => {
  it("renders the app version in the drawer footer and keeps it out of the topbar", async () => {
    const wrapper = await mountApp();

    const drawer = wrapper.get('[data-testid="mobile-drawer"]');
    const footer = drawer.get('[data-testid="drawer-footer"]');
    expect(footer.get(".drawerBrandTitle").text()).toBe("ADS");
    expect(footer.get(".drawerBrandVersion").text()).toBe("v0.0.1");

    const topbar = wrapper.get("header.topbar");
    expect(topbar.find(".brand").exists()).toBe(false);
    expect(topbar.text()).not.toContain("0.0.1");

    wrapper.unmount();
  });
});

describe("App.reorderProjects optimistic update", () => {
  type RemoteProject = {
    id: string;
    workspaceRoot: string;
    name: string;
    chatSessionId: string;
    createdAt?: number;
    updatedAt?: number;
  };

  let projectsFromApi: RemoteProject[] = [];

  beforeEach(() => {
    projectsFromApi = [];
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/projects") return { projects: projectsFromApi, activeProjectId: "p1" };
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  it("reorders immediately and persists via /api/projects/reorder", async () => {
    projectsFromApi = [
      { id: "p1", workspaceRoot: "/w/p1", name: "P1", chatSessionId: "main", createdAt: 1, updatedAt: 1 },
      { id: "p2", workspaceRoot: "/w/p2", name: "P2", chatSessionId: "main", createdAt: 2, updatedAt: 2 },
      { id: "p3", workspaceRoot: "/w/p3", name: "P3", chatSessionId: "main", createdAt: 3, updatedAt: 3 },
    ];

    const d = defer<{ success: boolean }>();
    postImpl = async (url: string, body: unknown) => {
      expect(url).toBe("/api/projects/reorder");
      expect(body).toEqual({ ids: ["p3", "p1", "p2"] });
      projectsFromApi = [projectsFromApi[2]!, projectsFromApi[0]!, projectsFromApi[1]!];
      return d.promise;
    };

    const wrapper = await mountApp();

    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p2", "p3"]);

    const reorderPromise = (wrapper.vm as unknown as { reorderProjects: (ids: string[]) => Promise<void> }).reorderProjects([
      "p3",
      "p1",
      "p2",
    ]);
    await settleUi(wrapper);
    expect(idsFromVm(wrapper as any)).toEqual(["default", "p3", "p1", "p2"]);

    d.resolve({ success: true });
    await reorderPromise;
    await settleUi(wrapper);

    wrapper.unmount();

    const wrapper2 = await mountApp();
    expect(idsFromVm(wrapper2 as any)).toEqual(["default", "p3", "p1", "p2"]);
    wrapper2.unmount();
  });

  it("rolls back on API failure", async () => {
    projectsFromApi = [
      { id: "p1", workspaceRoot: "/w/p1", name: "P1", chatSessionId: "main", createdAt: 1, updatedAt: 1 },
      { id: "p2", workspaceRoot: "/w/p2", name: "P2", chatSessionId: "main", createdAt: 2, updatedAt: 2 },
      { id: "p3", workspaceRoot: "/w/p3", name: "P3", chatSessionId: "main", createdAt: 3, updatedAt: 3 },
    ];

    postImpl = async () => {
      throw new Error("boom");
    };

    const wrapper = await mountApp();

    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p2", "p3"]);

    await (wrapper.vm as unknown as { reorderProjects: (ids: string[]) => Promise<void> }).reorderProjects(["p3", "p1", "p2"]);
    await settleUi(wrapper);

    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p2", "p3"]);

    wrapper.unmount();
  });
});

describe("default project websocket session", () => {
  it("uses ads-session.default for the initial default project connection", async () => {
    const wrapper = await mountApp();

    expect(wsSessionIds.length).toBeGreaterThan(0);
    expect(wsSessionIds[0]).toBe("default");

    wrapper.unmount();
  });
});

describe("mobile navigation shell (mobile-pane-tabs)", () => {
  it("renders Advisor and Worker tabs in one shared tab list and switches panels on tab click", async () => {
    const wrapper = await mountApp();

    const tablist = wrapper.get('[role="tablist"]');
    const tabs = tablist.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.get(".laneTabLabel").text())).toEqual(["Acopilot", "Actions"]);
    expect(tabs.map((tab) => tab.attributes("aria-selected"))).toEqual(["true", "false"]);
    expect(wrapper.find('[data-testid="lane-tab-tasks"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="lane-tab-reviewer"]').exists()).toBe(false);

    // Both lane panels stay mounted; the inactive one is hidden from view.
    expect(wrapper.find('[data-testid="lane-panel-acopilot"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-actions"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="lane-panel-actions"]').element as HTMLElement).style.display).toBe("none");
    expect((wrapper.find('[data-testid="lane-panel-acopilot"]').element as HTMLElement).style.display).toBe("");

    await wrapper.get('[data-testid="lane-tab-actions"]').trigger("click");
    await settleUi(wrapper);

    expect((wrapper.find('[data-testid="lane-panel-actions"]').element as HTMLElement).style.display).toBe("");
    expect((wrapper.find('[data-testid="lane-panel-acopilot"]').element as HTMLElement).style.display).toBe("none");
    expect(wrapper.get('[data-testid="lane-tab-actions"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.get('[data-testid="lane-tab-acopilot"]').attributes("aria-selected")).toBe("false");

    await wrapper.get('[data-testid="lane-tab-acopilot"]').trigger("click");
    await settleUi(wrapper);

    expect((wrapper.find('[data-testid="lane-panel-acopilot"]').element as HTMLElement).style.display).toBe("");
    expect((wrapper.find('[data-testid="lane-panel-actions"]').element as HTMLElement).style.display).toBe("none");

    wrapper.unmount();
  });
});

describe("project row mobile layout", () => {
  it("stacks project name and branch on mobile", async () => {
    const css = await readClientFile("../App.css");

    expect(css).toMatch(/\.projectText\s*\{[\s\S]*flex-direction:\s*column\s*;/);
    expect(css).toMatch(/\.projectBranch\s*\{[\s\S]*display:\s*block\s*;/);

    expect(css).not.toMatch(/@media\s*\(max-width:\s*900px\)[\s\S]*\.projectText\s*\{[\s\S]*flex-direction:\s*row\s*;/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*900px\)[\s\S]*\.projectBranch\s*\{[\s\S]*display:\s*inline\s*;/);
    expect(css).toMatch(/\.projectNode\.active\s+\.projectRowActions\s*\{[\s\S]*opacity:\s*1\s*[;\s][\s\S]*pointer-events:\s*auto\s*;/);
  });

  it("locks project item dimensions and configures mobile drawer project tree scrolling (Issue #338)", async () => {
    const css = await readClientFile("../App.css");

    // Base .projectNode rules
    expect(css).toMatch(/\.projectNode\s*\{[^}]*flex-shrink:\s*0\s*;/);
    expect(css).toMatch(/\.projectNode\s*\{[^}]*min-height:\s*46px\s*;/);

    // Mobile media query rules
    const mobileStart = css.indexOf("@media (max-width: 900px)");
    expect(mobileStart).toBeGreaterThan(-1);
    const mobileCss = css.slice(mobileStart);

    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*flex:\s*1 1 0\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*overflow-y:\s*auto\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*overflow-x:\s*hidden\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*padding:\s*8px 8px 24px\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*-webkit-overflow-scrolling:\s*touch\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*overscroll-behavior:\s*contain\s*;/);

    // Redundant title hidden and header aligned compactly
    expect(mobileCss).toMatch(/\.projectTreeTitle\s*\{[^}]*display:\s*none\s*;/);
    expect(mobileCss).toMatch(/\.projectTreeHeader\s*\{[^}]*justify-content:\s*flex-end\s*;/);

    // Short display (iPhone SE) navigation spacing
    expect(css).toMatch(/@media\s*\(max-height:\s*600px\)[\s\S]*?\.mobileDrawerNavItem\s*\{[^}]*min-height:\s*38px\s*;/);
    expect(css).toMatch(/@media\s*\(max-height:\s*600px\)[\s\S]*?\.mobileDrawerNavItem\s*\{[^}]*padding:\s*6px 10px\s*;/);
  });
});

describe("project status spinner", () => {
  it("shows lane-specific and combined project activity states", async () => {
    const wrapper = await mountApp();

    const pid = String((wrapper.vm as any).activeProjectId ?? "").trim();
    expect(pid).not.toBe("");

    const actionsRuntime = (wrapper.vm as any).getRuntime(pid) as { busy: { value: boolean } };
    const acopilotRuntime = (wrapper.vm as any).getAcopilotRuntime(pid) as { busy: { value: boolean } };
    actionsRuntime.busy.value = false;
    acopilotRuntime.busy.value = false;
    await settleUi(wrapper);

    expect(wrapper.find(".projectStatus").classes("spinning")).toBe(false);
    expect(wrapper.find('[data-testid="lane-tab-status-acopilot"]').classes("laneTabStatusDot--busy-acopilot")).toBe(false);
    expect(wrapper.find('[data-testid="lane-tab-status-actions"]').classes("laneTabStatusDot--busy-actions")).toBe(false);

    acopilotRuntime.busy.value = true;
    await settleUi(wrapper);
    const projectStatus = wrapper.find(".projectStatus");
    expect(projectStatus.classes()).toEqual(expect.arrayContaining(["spinning", "spinning--acopilot"]));
    expect(projectStatus.attributes("title")).toBe("Acopilot 正在规划…");
    expect(wrapper.find('[data-testid="lane-tab-status-acopilot"]').classes()).toContain("laneTabStatusDot--busy-acopilot");
    expect(wrapper.find('[data-testid="lane-tab-status-actions"]').classes("laneTabStatusDot--busy-actions")).toBe(false);

    actionsRuntime.busy.value = true;
    await settleUi(wrapper);
    expect(projectStatus.classes()).toEqual(expect.arrayContaining(["spinning", "spinning--both"]));
    expect(projectStatus.attributes("title")).toBe("Acopilot 与 Actions 均在运行中…");
    expect(wrapper.find('[data-testid="lane-tab-status-actions"]').classes()).toContain("laneTabStatusDot--busy-actions");

    acopilotRuntime.busy.value = false;
    await settleUi(wrapper);
    expect(projectStatus.classes()).toEqual(expect.arrayContaining(["spinning", "spinning--actions"]));
    expect(projectStatus.classes("spinning--acopilot")).toBe(false);
    expect(projectStatus.attributes("title")).toBe("Actions 正在执行…");

    actionsRuntime.busy.value = false;
    await settleUi(wrapper);
    expect(projectStatus.classes("spinning")).toBe(false);
    expect(projectStatus.attributes("title")).toBeUndefined();

    wrapper.unmount();
  });

  it("uses pulsing breathing animation for busy lane dots", async () => {
    const css = await readClientFile("../App.css");
    const advisorDot = css.match(/\.laneTabStatusDot--busy-acopilot\s*\{[^}]*\}/)?.[0];
    const workerDot = css.match(/\.laneTabStatusDot--busy-actions\s*\{[^}]*\}/)?.[0];

    expect(advisorDot).toBeDefined();
    expect(advisorDot).toMatch(/background:\s*#a855f7\s*;/);
    expect(advisorDot).toMatch(/animation:\s*laneDotPulse 1\.6s ease-in-out infinite\s*;/);

    expect(workerDot).toBeDefined();
    expect(workerDot).toMatch(/background:\s*#10b981\s*;/);
    expect(workerDot).toMatch(/animation:\s*laneDotPulse 1\.6s ease-in-out infinite\s*;/);

    expect(css).toMatch(/@keyframes\s+laneDotPulse\s*\{/);

    // Perceptibility floors (issue #480): the old 7px dot scaling to 1.2 with
    // a 0.2-alpha ring was below the visibility threshold on high-DPI phones,
    // and the regex assertions above passed anyway. Assert the amplitude
    // itself, not just the declaration strings.
    const baseDot = css.match(/\.laneTabStatusDot\s*\{[^}]*\}/)?.[0] ?? "";
    const dotSize = Number(baseDot.match(/width:\s*(\d+(?:\.\d+)?)px/)?.[1]);
    expect(dotSize).toBeGreaterThanOrEqual(8);

    const keyframes = css.match(/@keyframes\s+laneDotPulse\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    const peakScale = Math.max(...[...keyframes.matchAll(/scale\((\d+(?:\.\d+)?)\)/g)].map((match) => Number(match[1])));
    expect(peakScale).toBeGreaterThanOrEqual(1.4);
    const rings = [...keyframes.matchAll(/0 0 0 (\d+(?:\.\d+)?)px rgba\(var\(--lane-pulse-color\),\s*(\d+(?:\.\d+)?)\)/g)]
      .map((match) => ({ spread: Number(match[1]), alpha: Number(match[2]) }));
    expect(rings.some((ring) => ring.spread >= 5 && ring.alpha >= 0.4)).toBe(true);

    // The global reduced-motion override zeroes all animation; the busy dot
    // must be exempted there or a busy lane silently loses its indicator.
    const globalCss = await readClientFile("../global.css");
    expect(globalCss).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*\.laneTabStatusDot--busy-acopilot[\s\S]*?animation:\s*none\s*!important[\s\S]*?box-shadow:/,
    );
  });
});

describe("project and lane composer draft isolation (project-switch-clears-composer)", () => {
  beforeEach(() => {
    loginGateEmitSync = true;
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "sess-a", path: "/tmp/project-a", name: "A", initialized: true },
        { sessionId: "sess-b", path: "/tmp/project-b", name: "B", initialized: true },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "sess-a");
  });

  it("preserves lane-local drafts across tab switches without leaking across projects", async () => {
    const wrapper = await mountApp({ MainChatView: false, MainChatComposerPanel: false });

    await switchLane(wrapper, "actions");
    const workerTextareaA = getLaneTextarea(wrapper, "actions");
    expect(workerTextareaA.exists()).toBe(true);
    await workerTextareaA.setValue("worker draft text");
    expect((workerTextareaA.element as HTMLTextAreaElement).value).toBe("worker draft text");

    await switchLane(wrapper, "acopilot");
    const advisorTextareaA = getLaneTextarea(wrapper, "acopilot");
    await advisorTextareaA.setValue("advisor draft line 1\nadvisor draft line 2");
    expect((advisorTextareaA.element as HTMLTextAreaElement).value).toBe("advisor draft line 1\nadvisor draft line 2");

    await switchLane(wrapper, "actions");
    expect((getLaneTextarea(wrapper, "actions").element as HTMLTextAreaElement).value).toBe("worker draft text");

    await switchLane(wrapper, "acopilot");
    expect((getLaneTextarea(wrapper, "acopilot").element as HTMLTextAreaElement).value).toBe(
      "advisor draft line 1\nadvisor draft line 2",
    );

    await switchLane(wrapper, "actions");

    const projectRows = wrapper.findAll("button.projectRow");
    expect(projectRows.length).toBeGreaterThanOrEqual(2);
    const rowB = projectRows.find((row) => row.text().includes("B")) ?? null;
    expect(rowB).toBeTruthy();
    await rowB!.trigger("click");
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");

    const workerTextareaB = getLaneTextarea(wrapper, "actions");
    expect(workerTextareaB.exists()).toBe(true);
    expect((workerTextareaB.element as HTMLTextAreaElement).value).toBe("");

    await switchLane(wrapper, "acopilot");
    expect((getLaneTextarea(wrapper, "acopilot").element as HTMLTextAreaElement).value).toBe("");

    const rowA = projectRows.find((row) => row.text().includes("A")) ?? null;
    expect(rowA).toBeTruthy();
    await rowA!.trigger("click");
    await settleUi(wrapper);

    await switchLane(wrapper, "actions");
    expect((getLaneTextarea(wrapper, "actions").element as HTMLTextAreaElement).value).toBe("worker draft text");
    await switchLane(wrapper, "acopilot");
    expect((getLaneTextarea(wrapper, "acopilot").element as HTMLTextAreaElement).value).toBe(
      "advisor draft line 1\nadvisor draft line 2",
    );

    wrapper.unmount();
  }, 30_000);

  it("returns to the worker lane on project switches so preserved worker context stays visible", async () => {
    const wrapper = await mountApp({ MainChatView: false, MainChatComposerPanel: false });

    await switchLane(wrapper, "actions");
    await getLaneTextarea(wrapper, "actions").setValue("worker context A");
    await switchLane(wrapper, "acopilot");
    await getLaneTextarea(wrapper, "acopilot").setValue("advisor draft A");
    expect((wrapper.vm as any).activeChatLane).toBe("acopilot");

    const projectRows = wrapper.findAll("button.projectRow");
    const rowB = projectRows.find((row) => row.text().includes("B")) ?? null;
    expect(rowB).toBeTruthy();
    await rowB!.trigger("click");
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");
    expect((wrapper.vm as any).activeChatLane).toBe("actions");
    expect((getLaneTextarea(wrapper, "actions").element as HTMLTextAreaElement).value).toBe("");

    const rowA = wrapper.findAll("button.projectRow").find((row) => row.text().includes("A")) ?? null;
    expect(rowA).toBeTruthy();
    await rowA!.trigger("click");
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-a");
    expect((wrapper.vm as any).activeChatLane).toBe("actions");
    expect((getLaneTextarea(wrapper, "actions").element as HTMLTextAreaElement).value).toBe("worker context A");

    wrapper.unmount();
  }, 30_000);
});

describe("PWA manifest navigation", () => {
  it("uses the deployment base as the stable app id, start URL, and scope", async () => {
    const config = await readSfc("../../vite.config.ts", import.meta.url);

    expect(config).toContain("id: base");
    expect(config).toContain("start_url: base");
    expect(config).toContain("scope: base");
  });

  it("shields the initial claim from reloading and defers updates to a user prompt", async () => {
    const config = await readSfc("../../vite.config.ts", import.meta.url);
    expect(config).toContain("injectRegister: false");
    expect(config).toContain("clientsClaim: true");

    const script = await readSfc("../../public/registerSW.js", import.meta.url);
    // The service worker must not self-activate mid-session; the page decides.
    expect(config).not.toContain("skipWaiting: true");
    // The initial clientsClaim must not reload the page: only reload when a
    // controller already existed before this page load.
    expect(script).toContain("hadController");
    expect(script).toContain("if (refreshing || !hadController) return;");
    // No silent cold-start activation racing the app boot; updates are applied
    // only after explicit user confirmation via the toast.
    expect(script).not.toContain('.getRegistration("/")');
    expect(script).not.toContain("applyWaitingWorker(registration);");
    expect(script).toContain('postMessage({ type: "SKIP_WAITING" })');
    // Mid-session: show a user-controlled update toast instead of force-reloading.
    expect(script).toContain("新版本已就绪");
    expect(script).toContain("立即更新");
  });
});

describe("LoginGate", () => {
  beforeEach(() => {
    loginGateMode = "real";
    getImpl = async (url: string) => {
      if (url === "/api/auth/status") return { initialized: true };
      if (url === "/api/auth/me") throw new Error("unauthorized");
      throw new Error(`unexpected GET ${url}`);
    };
    postImpl = async (url: string) => {
      if (url === "/api/auth/login") return { success: true };
      throw new Error(`unexpected POST ${url}`);
    };
  });

  it("sizes the gate from the visual viewport height with a 100dvh fallback (Issue #476)", async () => {
    const source = await readClientFile("../components/LoginGate.vue");
    const gateRule = source.match(/\.gate\s*\{[^}]*\}/)?.[0];

    expect(gateRule).toBeDefined();
    expect(gateRule).toContain("min-height: var(--ads-visual-viewport-height, 100dvh);");
    expect(gateRule).toContain("height: var(--ads-visual-viewport-height, 100dvh);");
    // The inert keyboard-open state was removed; viewport metrics come from
    // the global installViewportCssVars() layer only.
    expect(source).not.toContain("keyboard-open");
  });

  it("does not unmount inputs or show skeleton on background visibility refresh when already initialized", async () => {
    const wrapper = mount(LoginGate, { attachTo: document.body });
    try {
      await waitForLoginInputs(wrapper);
      expect(wrapper.findAll("input").length).toBe(2);
      expect(wrapper.find(".skeleton").exists()).toBe(false);

      // Trigger visibility change event in background
      document.dispatchEvent(new Event("visibilitychange"));
      await wrapper.vm.$nextTick();

      // Inputs should remain firmly mounted with no skeleton flicker
      expect(wrapper.findAll("input").length).toBe(2);
      expect(wrapper.find(".skeleton").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});
