import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, flushPromises, mount } from "@vue/test-utils";
import type { AgyAccountView, ModelConfig, RuntimesSnapshot } from "../api/types";
import { supportsAgentModel } from "../lib/model_agent";
import MainChatModelSelectors from "../components/MainChatModelSelectors.vue";
import ModelManager from "../components/ModelManager.vue";

describe("supportsAgentModel across native, codex, claude, and agy runtimes", () => {
  const providerBoundModel: ModelConfig = {
    id: "model-provider-gpt",
    modelId: "gpt-4.1",
    displayName: "GPT-4.1",
    provider: "OpenAI",
    providerId: "provider-openai",
    isEnabled: true,
    isDefault: true,
  };
  const codexAcpModel: ModelConfig = {
    id: "gpt-5.3-codex",
    modelId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    provider: "codex",
    providerId: null,
    isEnabled: true,
    isDefault: true,
    configJson: {
      allowedAgents: ["codex"],
      reasoningEfforts: ["medium", "high"],
      runtime: "codex",
    },
  };
  const claudeModel: ModelConfig = {
    id: "claude-sonnet-4",
    modelId: "claude-sonnet-4",
    displayName: "Claude Sonnet 4",
    provider: "Anthropic",
    providerId: "provider-anthropic",
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
      runtime: "agy",
    },
  };

  const legacyProviderWithCodexTag: ModelConfig = {
    id: "model-legacy-provider",
    modelId: "gpt-5",
    displayName: "GPT-5 (Legacy Provider)",
    provider: "OpenAI",
    providerId: "provider-openai",
    isEnabled: true,
    isDefault: false,
    configJson: {
      allowedAgents: ["codex"],
    },
  };

  it("scopes Settings -> Providers models to native while codex and agy use ACP-discovered models", () => {
    expect(supportsAgentModel({ agentId: "native", model: providerBoundModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "native", model: legacyProviderWithCodexTag })).toBe(true);
    expect(supportsAgentModel({ agentId: "native", model: claudeModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "native", model: codexAcpModel })).toBe(false);
    expect(supportsAgentModel({ agentId: "native", model: agyModel })).toBe(false);

    expect(supportsAgentModel({ agentId: "codex", model: codexAcpModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "codex", model: providerBoundModel })).toBe(false);
    expect(supportsAgentModel({ agentId: "codex", model: legacyProviderWithCodexTag })).toBe(false);
    expect(supportsAgentModel({ agentId: "codex", model: claudeModel })).toBe(false);
    expect(supportsAgentModel({ agentId: "codex", model: agyModel })).toBe(false);

    expect(supportsAgentModel({ agentId: "agy", model: agyModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "agy:work", model: agyModel })).toBe(true);
    expect(supportsAgentModel({ agentId: "agy:personal", model: agyModel })).toBe(false);
    expect(supportsAgentModel({ agentId: "agy", model: providerBoundModel })).toBe(false);
    expect(supportsAgentModel({ agentId: "agy", model: codexAcpModel })).toBe(false);
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
      {
        id: "agy",
        name: "Antigravity",
        ready: true,
        accountEmail: "alice@example.com",
        tier: "Pro",
      },
      {
        id: "agy:api-key",
        name: "API Key Agy",
        ready: true,
      },
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

    const agyBtn = wrapper.get('[data-testid="agent-picker-item-agy"]');
    expect(agyBtn.get('[data-testid="agent-picker-tier-agy"]').text()).toBe("Pro");
    expect(agyBtn.get('[data-testid="agent-picker-detail-agy"]').text()).toBe("alice@example.com · agy");

    const apiKeyBtn = wrapper.get('[data-testid="agent-picker-item-agy:api-key"]');
    expect(apiKeyBtn.find('[data-testid="agent-picker-tier-agy:api-key"]').exists()).toBe(false);
    expect(apiKeyBtn.get('[data-testid="agent-picker-detail-agy:api-key"]').text()).toBe("agy:api-key");

    await agyBtn.trigger("click");
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
        {
          id: "agy",
          name: "Antigravity",
          kind: "agy",
          ready: true,
          version: "1.5.18",
          accountEmail: "host@example.com",
          tier: "Ultra",
        },
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
        accountEmail: "host@example.com",
        tier: "Ultra",
        error: null,
        modelCount: 2,
        loginPending: false,
        authorizationUrl: null,
      },
      {
        id: "api-key-acct",
        agentId: "agy:api-key-acct",
        label: "API Key Account",
        isDefault: false,
        authMethod: "gemini-api-key",
        hasApiKey: true,
        ready: true,
        status: "ready",
        version: "1.5.18",
        accountEmail: null,
        tier: null,
        error: null,
        modelCount: 1,
        loginPending: false,
        authorizationUrl: null,
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
            error: "Sign in required for this Antigravity account.",
            modelCount: 0,
            loginPending: false,
            authorizationUrl: null,
          };
          accounts.push(created);
          return structuredClone(created);
        }
        if (url === "/api/runtimes/agy/accounts/work-google/login/start") {
          const acc = accounts.find((a) => a.id === "work-google")!;
          acc.loginPending = true;
          acc.authorizationUrl = "https://accounts.google.com/o/oauth2/auth?response_type=code&state=s1";
          return {
            accountId: "work-google",
            agentId: "agy:work-google",
            flowId: "flow-1",
            authorizationUrl: acc.authorizationUrl,
            redirectUri: "https://antigravity.google/oauth-callback",
            state: "s1",
          };
        }
        if (url === "/api/runtimes/agy/accounts/work-google/login/complete") {
          const acc = accounts.find((a) => a.id === "work-google")!;
          acc.ready = true;
          acc.status = "ready";
          acc.accountEmail = "work@example.com";
          acc.tier = "Pro";
          acc.error = null;
          acc.modelCount = 2;
          acc.loginPending = false;
          acc.authorizationUrl = null;
          return structuredClone(acc);
        }
        if (url === "/api/runtimes/agy/accounts/work-google/logout") {
          const acc = accounts.find((a) => a.id === "work-google")!;
          acc.ready = false;
          acc.status = "authentication_required";
          acc.accountEmail = null;
          acc.tier = null;
          acc.error = "Signed out. Sign in again to use this account.";
          acc.modelCount = 0;
          acc.loginPending = false;
          acc.authorizationUrl = null;
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

    // Providers remains the default active tab and scopes Providers to Native runtime.
    expect(wrapper.get('[data-testid="provider-settings-tab"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="settings-providers-panel"]').text()).toContain(
      "Native runtime providers",
    );

    // Switch to Runtimes tab.
    await wrapper.get('[data-testid="runtime-settings-tab"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="settings-runtimes-panel"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="runtime-row-agy"]').text()).toContain("Ready");
    expect(wrapper.get('[data-testid="runtime-tier-agy"]').text()).toBe("Ultra");
    expect(wrapper.get('[data-testid="runtime-row-agy"]').text()).toContain("host@example.com · agy · v1.5.18");

    // Host default card displays email & concise tier badge; API-key card omits them cleanly.
    expect(wrapper.get('[data-testid="agy-account-email-default"]').text()).toBe("host@example.com");
    expect(wrapper.get('[data-testid="agy-account-tier-default"]').text()).toBe("Ultra");
    expect(wrapper.find('[data-testid="agy-account-email-api-key-acct"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="agy-account-tier-api-key-acct"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="agy-account-row-api-key-acct"]').text()).not.toContain("·  ·");

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
    expect(wrapper.get('[data-testid="agy-account-row-work-google"]').text()).toContain("Sign in required for this Antigravity account.");

    // Start OAuth flow and verify reopening the tab restores loginPending / authorizationUrl.
    await wrapper.get('[data-testid="agy-login-start-work-google"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="provider-settings-tab"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="runtime-settings-tab"]').trigger("click");
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
    expect(wrapper.get('[data-testid="agy-account-email-work-google"]').text()).toBe("work@example.com");
    expect(wrapper.get('[data-testid="agy-account-tier-work-google"]').text()).toBe("Pro");

    // Sign out and delete account.
    await wrapper.get('[data-testid="agy-logout-work-google"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="agy-account-row-work-google"]').text()).toContain("Sign in required");
    expect(wrapper.find('[data-testid="agy-account-email-work-google"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="agy-account-tier-work-google"]').exists()).toBe(false);

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
