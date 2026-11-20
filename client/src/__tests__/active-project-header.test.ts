import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

type RemoteProject = {
  id: string;
  workspaceRoot: string;
  name: string;
  chatSessionId: string;
  branch?: string;
};

type SocketRecord = {
  lane: "actions" | "acopilot";
  sessionId: string;
  onMessage?: (message: unknown) => void;
};

let projects: RemoteProject[] = [];
let activeProjectId: string | null = null;
const sockets: SocketRecord[] = [];

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (url === "/api/models") return [] as T;
      if (url === "/api/projects") return { projects, activeProjectId } as T;
      if (url.startsWith("/api/paths/subdirs")) return { dirs: [], allowedDirs: [] } as T;
      if (url.startsWith("/api/paths/validate")) return { ok: false } as T;
      return {} as T;
    }

    async post<T>(): Promise<T> {
      return {} as T;
    }

    async patch<T>(): Promise<T> {
      return {} as T;
    }

    async delete<T>(): Promise<T> {
      return {} as T;
    }
  }

  return { ApiClient };
});

vi.mock("../api/ws", () => {
  class AdsWebSocket implements SocketRecord {
    lane: "actions" | "acopilot";
    sessionId: string;
    onOpen?: () => void;
    onClose?: (event: { code: number; reason?: string }) => void;
    onError?: () => void;
    onMessage?: (message: unknown) => void;

    constructor(options: { lane: "actions" | "acopilot"; sessionId: string }) {
      this.lane = options.lane;
      this.sessionId = options.sessionId;
      sockets.push(this);
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

  return {
    AdsWebSocket,
    getProjectWebSocketLane: (options: {
      sessionId: string;
      lane: "actions" | "acopilot";
      configs: Record<"actions" | "acopilot", { chatSessionId: string }>;
    }) => new AdsWebSocket({ lane: options.lane, sessionId: options.sessionId }),
  };
});

vi.mock("../components/LoginGate.vue", () => ({
  default: defineComponent({
    name: "LoginGate",
    emits: ["logged-in"],
    mounted() {
      queueMicrotask(() => this.$emit("logged-in", { id: "u-1", username: "admin" }));
    },
    template: "<div />",
  }),
}));

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await wrapper.vm.$nextTick();
    await Promise.resolve();
  }
}

async function mountApp(): Promise<ReturnType<typeof shallowMount>> {
  const App = (await import("../App.vue")).default;
  const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
  await settleUi(wrapper);
  for (let i = 0; i < 20; i += 1) {
    if (wrapper.find('[data-testid="active-project-context"]').exists()) return wrapper;
    await settleUi(wrapper);
  }
  return wrapper;
}

async function emitWorkspaceBranch(
  wrapper: ReturnType<typeof shallowMount>,
  branch: string,
): Promise<void> {
  const actionsSocket = sockets.find((socket) => socket.sessionId === "p1" && socket.lane === "actions");
  expect(actionsSocket).toBeDefined();
  actionsSocket!.onMessage?.({ type: "workspace", data: { path: "/w/ads", branch } });
  await settleUi(wrapper);
}

describe("active project header context", () => {
  let previousInnerWidth: number;

  beforeEach(() => {
    previousInnerWidth = window.innerWidth;
    sockets.length = 0;
    localStorage.clear();
    projects = [
      { id: "p1", workspaceRoot: "/w/ads", name: "ads", chatSessionId: "main", branch: "dev" },
    ];
    activeProjectId = "p1";
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: previousInnerWidth, configurable: true });
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("renders the active project and branch on desktop and updates from workspace state", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    const wrapper = await mountApp();
    await emitWorkspaceBranch(wrapper, "dev");

    expect(wrapper.get('[data-testid="active-project-context"]').attributes("title")).toBe("ads dev");
    expect(wrapper.get('[data-testid="active-project-context"]').attributes("role")).toBe("group");
    expect(wrapper.get('[data-testid="active-project-context"]').attributes("aria-label")).toBe("当前项目 ads，当前分支 dev");
    expect(wrapper.get('[data-testid="active-project-context-name"]').attributes("aria-hidden")).toBe("true");
    expect(wrapper.get('[data-testid="active-project-context-branch"]').attributes("aria-hidden")).toBe("true");

    await emitWorkspaceBranch(wrapper, "feature/header-context");

    expect(wrapper.get('[data-testid="active-project-context-branch"]').text()).toBe("feature/header-context");
    expect(wrapper.get('[data-testid="active-project-context"]').attributes("title")).toBe("ads feature/header-context");
    wrapper.unmount();
  });

  it("normalizes detached HEAD and omits an empty branch", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    projects[0]!.branch = "HEAD";
    let wrapper = await mountApp();
    await emitWorkspaceBranch(wrapper, "HEAD");
    expect(wrapper.get('[data-testid="active-project-context-branch"]').text()).toBe("detached");
    wrapper.unmount();

    sockets.length = 0;
    projects[0]!.branch = "   ";
    wrapper = await mountApp();
    await emitWorkspaceBranch(wrapper, "   ");
    expect(wrapper.find('[data-testid="active-project-context-branch"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="active-project-context"]').text()).toBe("ads");
    expect(wrapper.get('[data-testid="active-project-context"]').attributes("title")).toBe("ads");
    expect(wrapper.get('[data-testid="active-project-context"]').attributes("aria-label")).toBe("当前项目 ads");
    wrapper.unmount();
  });

  it("keeps full long values in accessible labels on mobile", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    const longName = "ads-project-with-a-long-context-name";
    const longBranch = "feature/a-very-long-branch-name-for-mobile";
    projects[0] = { ...projects[0]!, name: longName, branch: longBranch };
    const wrapper = await mountApp();
    await emitWorkspaceBranch(wrapper, longBranch);

    expect(wrapper.find('[data-testid="mobile-drawer-toggle"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="active-project-context"]').classes()).toContain("activeProjectContext");
    expect(wrapper.get('[data-testid="active-project-context-name"]').attributes("title")).toBe(longName);
    expect(wrapper.get('[data-testid="active-project-context-branch"]').attributes("title")).toBe(longBranch);
    expect(wrapper.get('[data-testid="active-project-context"]').attributes("title")).toBe(`${longName} ${longBranch}`);
    wrapper.unmount();
  });
});
