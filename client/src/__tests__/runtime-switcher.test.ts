import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, flushPromises, mount } from "@vue/test-utils";
import type { AgyAccountView, ModelConfig, RuntimesSnapshot } from "../api/types";
import { supportsAgentModel } from "../lib/model_agent";
import MainChatModelSelectors from "../components/MainChatModelSelectors.vue";
import ModelManager from "../components/ModelManager.vue";

describe("supportsAgentModel across native, codex, claude, and agy runtimes", () => {
  const openaiModel: ModelConfig = {
    id: "gpt-4.1",
    modelId: "gpt-4.1",
    displayName: "GPT-4.1",
    provider: "OpenAI",
    isEnabled: true,
    isDefault: true,
  };
  const claudeModel: ModelConfig = {
    id: "claude-sonnet-4",
    modelId: "claude-sonnet-4",
    displayName: "Claude Sonnet 4",
    provider: "Anthropic",
    isEnabled: true,
    isDefault: false,
  };
  const agyModel: ModelConfig = {
    id: "gemini-2.5-pro",
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    provider: "antigravity",
    isEnabled: true,
    isDefault: true,
    configJson: {
      allowedAgents: ["agy", "agy:work"],
      reasoningEfforts: ["low", "medium", "high"],
    },
  };

  it("matches user-configured models for native and codex while scoping agy models by allowedAgents", () => {
    expect(supportsAgentModel({ agentId: "native", model: openaiModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "native", model: claudeModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "native", model: agyModel })).toBe(false);

    expect(supportsAgentModel({ agentId: "codex", model: openaiModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "codex", model: claudeModel })).toBe(false);
    expect(supportsAgentModel({ agentId: "codex", model: agyModel })).toBe(false);

    expect(supportsAgentModel({ agentId: "agy", model: agyModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "agy:work", model: agyModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "agy:personal", model: agyModel })).toBe(false);
    expect(supportsAgentModel({ agentId: "agy", model: openaiModel })).toBe(false);
  });
});

describe("MainChatModelSelectors runtime switcher", () => {
  beforeEach(() => {
    config.global.stubs.teleport = true;
  });

  afterEach(() => {
    delete config.global.stubs.teleport;
  });

  it("renders runtime badge, allows switching ready runtimes, and disables unready runtimes", async () => {
    const models: ModelConfig[] = [
      {
        id: "gpt-4.1",
        modelId: "gpt-4.1",
        displayName: "GPT-4.1",
        provider: "OpenAI",
        isEnabled: true,
        isDefault: true,
      },
      {
        id: "gemini-2.5-pro",
        modelId: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        provider: "antigravity",
        isEnabled: true,
        isDefault: true,
        configJson: { allowedAgents: ["agy"], reasoningEfforts: ["medium", "high"] },
      },
    ];
    const agents = [
      { id: "native", name: "Native", ready: true },
      { id: "codex", name: "Codex", ready: false, error: "codex CLI not found" },
      { id: "agy", name: "Antigravity", ready: true },
    ];

    const wrapper = mount(MainChatModelSelectors, {
      props: {
        connected: true,
        busy: false,
        agents,
        activeAgentId: "native",
        models,
        modelId: "gpt-4.1",
        modelReasoningEffort: "high",
      },
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="chat-capsule-agent"]').text()).toBe("Native");
    await wrapper.get('[data-testid="chat-model-capsule"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="agent-picker-section"]').exists()).toBe(true);
    const codexBtn = wrapper.get('[data-testid="agent-picker-item-codex"]');
    expect(codexBtn.attributes("disabled")).toBeDefined();
    expect(codexBtn.text()).toContain("codex CLI not found");

    await wrapper.get('[data-testid="agent-picker-item-agy"]').trigger("click");
    expect(wrapper.emitted("switchAgent")).toEqual([["agy"]]);

    wrapper.unmount();
  });

  it("allows opening picker to switch runtime even when active runtime has zero models", async () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        connected: true,
        busy: false,
        agents: [
          { id: "native", name: "Native", ready: true },
          { id: "agy", name: "Antigravity", ready: true },
        ],
        activeAgentId: "native",
        models: [
          {
            id: "gemini-2.5-pro",
            modelId: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            provider: "antigravity",
            isEnabled: true,
            isDefault: true,
            configJson: { allowedAgents: ["agy"] },
          },
        ],
        modelId: "",
      },
    });
    await flushPromises();

    const capsule = wrapper.get('[data-testid="chat-model-capsule"]');
    expect(capsule.attributes("disabled")).toBeUndefined();
    await capsule.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="agent-picker-section"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("AntigravityAccountsPanel inside ModelManager Runtimes tab", () => {
  beforeEach(() => {
    config.global.stubs.teleport = true;
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    delete config.global.stubs.teleport;
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("creates an isolated account, completes OAuth code flow, logs out, and deletes cleanly", async () => {
    const snapshot: RuntimesSnapshot = {
      activeAgentId: "native",
      agents: [
        { id: "native", name: "Native", kind: "native", ready: true },
        { id: "agy", name: "Antigravity", kind: "agy", ready: true, version: "1.5.18" },
      ],
    };
    const accounts: AgyAccountView[] = [
      {
        id: "default",
        agentId: "agy",
        label: "Antigravity",
        isDefault: true,
        authMethod: "oauth-personal",
        hasApiKey: false,
        ready: true,
        status: "ready",
        version: "1.5.18",
        modelCount: 2,
        models: ["gemini-2.5-pro", "gemini-2.5-flash"],
        probedAtMs: 1,
      },
    ];

    const api = {
      get: vi.fn(async (url: string) => {
        if (url === "/api/runtimes") return structuredClone(snapshot);
        if (url === "/api/runtimes/agy/accounts") return structuredClone(accounts);
        return [];
      }),
      post: vi.fn(async (url: string, body?: Record<string, unknown>) => {
        if (url === "/api/runtimes/agy/accounts") {
          const created: AgyAccountView = {
            id: "work-google",
            agentId: "agy:work-google",
            label: String(body?.label ?? "Work Google"),
            isDefault: false,
            authMethod: (body?.authMethod as AgyAccountView["authMethod"]) ?? "oauth-personal",
            hasApiKey: false,
            ready: false,
            status: "authentication_required",
            message: "Sign in required",
            modelCount: 0,
            models: [],
            probedAtMs: 2,
          };
          accounts.push(created);
          return structuredClone(created);
        }
        if (url === "/api/runtimes/agy/accounts/work-google/login/start") {
          return {
            accountId: "work-google",
            agentId: "agy:work-google",
            flowId: "flow-1",
            authorizationUrl: "https://accounts.google.com/o/oauth2/auth?response_type=code&state=s1",
            redirectUri: "https://codeassist.google.com/authcode",
            state: "s1",
          };
        }
        if (url === "/api/runtimes/agy/accounts/work-google/login/complete") {
          const acc = accounts.find((a) => a.id === "work-google")!;
          acc.ready = true;
          acc.status = "ready";
          acc.modelCount = 2;
          return structuredClone(acc);
        }
        if (url === "/api/runtimes/agy/accounts/work-google/logout") {
          const acc = accounts.find((a) => a.id === "work-google")!;
          acc.ready = false;
          acc.status = "authentication_required";
          acc.modelCount = 0;
          return structuredClone(acc);
        }
        if (url === "/api/runtimes/refresh") {
          return structuredClone(snapshot);
        }
        return { success: true };
      }),
      patch: vi.fn(async () => ({})),
      put: vi.fn(async () => ({})),
      delete: vi.fn(async (url: string) => {
        if (url === "/api/runtimes/agy/accounts/work-google") {
          const idx = accounts.findIndex((a) => a.id === "work-google");
          if (idx >= 0) accounts.splice(idx, 1);
        }
        return { success: true };
      }),
    };

    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();

    // Providers remains the default active tab.
    expect(wrapper.get('[data-testid="provider-settings-tab"]').attributes("aria-pressed")).toBe("true");

    // Switch to Runtimes tab.
    await wrapper.get('[data-testid="runtime-settings-tab"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="settings-runtimes-panel"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="runtime-row-agy"]').text()).toContain("Ready");

    // Add isolated OAuth account.
    await wrapper.get('[data-testid="agy-account-add"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="agy-account-label"]').setValue("Work Google");
    await wrapper.get('[data-testid="agy-account-form"]').trigger("submit");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(
      "/api/runtimes/agy/accounts",
      expect.objectContaining({ label: "Work Google", authMethod: "oauth-personal" }),
    );
    expect(wrapper.get('[data-testid="agy-account-row-work-google"]').text()).toContain("Sign in required");

    // Start and complete OAuth flow.
    await wrapper.get('[data-testid="agy-login-start-work-google"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="agy-login-link-work-google"]').attributes("href")).toContain(
      "https://accounts.google.com/o/oauth2/auth",
    );
    await wrapper.get('[data-testid="agy-login-code-work-google"]').setValue("ok-code");
    await wrapper.get('[data-testid="agy-login-complete-work-google"]').trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(
      "/api/runtimes/agy/accounts/work-google/login/complete",
      { code: "ok-code" },
    );
    expect(wrapper.get('[data-testid="agy-account-row-work-google"]').text()).toContain("Ready · 2 models");

    // Sign out and delete account.
    await wrapper.get('[data-testid="agy-logout-work-google"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="agy-account-row-work-google"]').text()).toContain("Sign in required");

    await wrapper.get('[data-testid="agy-delete-work-google"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="agy-account-delete-confirm"] [data-testid="sheet-done"]').trigger("click");
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith("/api/runtimes/agy/accounts/work-google");
    expect(wrapper.find('[data-testid="agy-account-row-work-google"]').exists()).toBe(false);
    expect((wrapper.emitted("changed") ?? []).length).toBeGreaterThanOrEqual(4);

    wrapper.unmount();
  });
});
