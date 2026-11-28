import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, flushPromises, mount } from "@vue/test-utils";
import type { AgyAccountView, ModelConfig, RuntimesSnapshot } from "../api/types";
import {
  AGY_PENDING_LOGIN_TTL_MS,
  clearPendingAgyLoginView,
  hasPendingAgyLoginView,
  markPendingAgyLoginView,
} from "../lib/agyPendingLogin";
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
    expect(wrapper.find('[data-testid="agent-picker-section"] [data-testid="agent-picker-item-agy:api-key"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="agent-picker-runtime-agy"]').text()).toContain("Antigravity");
    expect(wrapper.get('[data-testid="agent-picker-runtime-agy"]').text()).toContain("2 of 2 accounts ready");
    expect(wrapper.get('[data-testid="agy-account-picker-section"]').exists()).toBe(true);

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

    await wrapper.setProps({ activeAgentId: "agy:api-key" });
    await flushPromises();
    expect(wrapper.get('[data-testid="chat-capsule-agent"]').text()).toBe("Antigravity");

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
    expect(wrapper.find('[data-testid="agy-account-picker-section"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="agent-picker-item-agy"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("switches to a ready isolated Antigravity account when host default is unavailable", async () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        connected: true,
        busy: false,
        agents: [
          { id: "native", name: "Native", ready: true },
          { id: "agy", name: "Antigravity", ready: false, error: "Sign in required" },
          { id: "agy:api-key", name: "Gemini API Key", ready: true },
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
            configJson: { allowedAgents: ["agy:api-key"] },
          },
        ],
        modelId: "",
      },
    });
    await flushPromises();

    await wrapper.get('[data-testid="chat-model-capsule"]').trigger("click");
    await flushPromises();

    const agyRuntimeBtn = wrapper.get('[data-testid="agent-picker-runtime-agy"]');
    expect(agyRuntimeBtn.attributes("disabled")).toBeUndefined();
    expect(agyRuntimeBtn.text()).toContain("1 of 2 accounts ready");
    await agyRuntimeBtn.trigger("click");
    expect(wrapper.emitted("switchAgent")).toEqual([["agy:api-key"]]);

    await wrapper.setProps({ activeAgentId: "agy:api-key" });
    await flushPromises();
    expect(wrapper.get('[data-testid="agent-picker-runtime-agy"]').text()).toContain("Gemini API Key · 1/2 ready");
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

  it("creates an isolated account without label, keeps Detected runtimes collapsed, completes OAuth flow, logs out, and deletes cleanly", async () => {
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
        {
          id: "agy:api-key-acct",
          name: "Gemini API Key",
          kind: "agy",
          ready: true,
          version: "1.5.18",
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
        label: "Gemini API Key",
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
            id: "acct-work1234",
            agentId: "agy:acct-work1234",
            label: String(body?.label ?? "Google OAuth (Personal)"),
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
          snapshot.agents.push({
            id: "agy:acct-work1234",
            name: created.label,
            kind: "agy",
            ready: false,
            error: created.error,
          });
          return structuredClone(created);
        }
        if (url === "/api/runtimes/agy/accounts/acct-work1234/login/start") {
          const acc = accounts.find((a) => a.id === "acct-work1234")!;
          acc.loginPending = true;
          acc.authorizationUrl = "https://accounts.google.com/o/oauth2/auth?response_type=code&state=s1";
          return {
            accountId: "acct-work1234",
            agentId: "agy:acct-work1234",
            flowId: "flow-1",
            authorizationUrl: acc.authorizationUrl,
            redirectUri: "https://antigravity.google/oauth-callback",
            state: "s1",
          };
        }
        if (url === "/api/runtimes/agy/accounts/acct-work1234/login/complete") {
          const acc = accounts.find((a) => a.id === "acct-work1234")!;
          acc.ready = true;
          acc.status = "ready";
          acc.accountEmail = "work@example.com";
          acc.tier = "Pro";
          acc.error = null;
          acc.modelCount = 2;
          acc.loginPending = false;
          acc.authorizationUrl = null;
          const rt = snapshot.agents.find((r) => r.id === "agy:acct-work1234")!;
          rt.ready = true;
          rt.accountEmail = "work@example.com";
          rt.tier = "Pro";
          rt.error = null;
          return structuredClone(acc);
        }
        if (url === "/api/runtimes/agy/accounts/acct-work1234/logout") {
          const acc = accounts.find((a) => a.id === "acct-work1234")!;
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
        if (url === "/api/runtimes/agy/accounts/acct-work1234") {
          const idx = accounts.findIndex((a) => a.id === "acct-work1234");
          if (idx >= 0) accounts.splice(idx, 1);
          const rtIdx = snapshot.agents.findIndex((r) => r.id === "agy:acct-work1234");
          if (rtIdx >= 0) snapshot.agents.splice(rtIdx, 1);
        }
        return { success: true };
      }),
    };

    const clipboardWrite = vi.fn(async () => {});
    const clipboardRead = vi.fn(async () => "ok-code");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite, readText: clipboardRead },
    });

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
    // Detected runtimes collapses all agy* accounts into the single Antigravity runtime row.
    expect(wrapper.get('[data-testid="runtime-row-agy"]').text()).toContain("Ready");
    expect(wrapper.get('[data-testid="runtime-row-agy"]').text()).toContain("2 accounts ready · agy · v1.5.18");
    expect(wrapper.find('[data-testid="runtime-row-agy:api-key-acct"]').exists()).toBe(false);

    // Host default card displays email & concise tier badge; API-key card omits them cleanly.
    expect(wrapper.get('[data-testid="agy-account-email-default"]').text()).toBe("host@example.com");
    expect(wrapper.get('[data-testid="agy-account-tier-default"]').text()).toBe("Ultra");
    expect(wrapper.find('[data-testid="agy-account-email-api-key-acct"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="agy-account-tier-api-key-acct"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="agy-account-row-api-key-acct"]').text()).not.toContain("·  ·");

    // Add isolated OAuth account without any label input.
    await wrapper.get('[data-testid="agy-account-add"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="agy-account-label"]').exists()).toBe(false);
    await wrapper.get('[data-testid="agy-account-form"]').trigger("submit");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(
      "/api/runtimes/agy/accounts",
      { authMethod: "oauth-personal" },
    );
    expect(wrapper.get('[data-testid="agy-account-row-acct-work1234"]').text()).toContain("Sign in required for this Antigravity account.");
    // Adding an account must NOT add a new row under Detected runtimes.
    expect(wrapper.find('[data-testid="runtime-row-agy:acct-work1234"]').exists()).toBe(false);

    // Start OAuth flow, copy link, and verify reopening ModelManager restores Runtimes + login flow.
    await wrapper.get('[data-testid="agy-login-start-acct-work1234"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="agy-login-copy-acct-work1234"]').trigger("click");
    await flushPromises();
    expect(clipboardWrite).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/auth?response_type=code&state=s1",
    );

    expect((wrapper.emitted("changed") ?? []).length).toBeGreaterThanOrEqual(1);
    wrapper.unmount();
    const restoredWrapper = mount(ModelManager, { props: { api: api as any, initialTab: "models" } });
    await flushPromises();
    expect(restoredWrapper.get('[data-testid="settings-runtimes-panel"]').exists()).toBe(true);
    expect(restoredWrapper.get('[data-testid="agy-login-link-acct-work1234"]').attributes("href")).toContain(
      "https://accounts.google.com/o/oauth2/auth",
    );
    const codeInput = restoredWrapper.get('[data-testid="agy-login-code-acct-work1234"]');
    expect(codeInput.element.closest(".settingsField")).toBeNull();

    // Paste code via 1-tap Paste button and complete sign-in.
    await restoredWrapper.get('[data-testid="agy-login-paste-acct-work1234"]').trigger("click");
    await flushPromises();
    await restoredWrapper.get('[data-testid="agy-login-complete-acct-work1234"]').trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith(
      "/api/runtimes/agy/accounts/acct-work1234/login/complete",
      { code: "ok-code" },
    );
    expect(restoredWrapper.get('[data-testid="agy-account-row-acct-work1234"]').text()).toContain("Ready · 2 models");
    expect(restoredWrapper.get('[data-testid="agy-account-email-acct-work1234"]').text()).toBe("work@example.com");
    expect(restoredWrapper.get('[data-testid="agy-account-tier-acct-work1234"]').text()).toBe("Pro");
    expect(restoredWrapper.find('[data-testid="runtime-row-agy:acct-work1234"]').exists()).toBe(false);

    // Sign out and delete account.
    await restoredWrapper.get('[data-testid="agy-logout-acct-work1234"]').trigger("click");
    await flushPromises();
    expect(restoredWrapper.get('[data-testid="agy-account-row-acct-work1234"]').text()).toContain("Sign in required");
    expect(restoredWrapper.find('[data-testid="agy-account-email-acct-work1234"]').exists()).toBe(false);
    expect(restoredWrapper.find('[data-testid="agy-account-tier-acct-work1234"]').exists()).toBe(false);

    await restoredWrapper.get('[data-testid="agy-delete-acct-work1234"]').trigger("click");
    await flushPromises();
    await restoredWrapper.get('[data-testid="agy-account-delete-confirm"] [data-testid="sheet-done"]').trigger("click");
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith("/api/runtimes/agy/accounts/acct-work1234");
    expect(restoredWrapper.find('[data-testid="agy-account-row-acct-work1234"]').exists()).toBe(false);
    expect((restoredWrapper.emitted("changed") ?? []).length).toBeGreaterThanOrEqual(3);

    restoredWrapper.unmount();
  });

  it("opens desktop sign-in via popup without double-opening, handles clipboard errors, cancels cleanly, and aggregates isolated ready agy runtime", async () => {
    const snapshot: RuntimesSnapshot = {
      activeAgentId: "native",
      agents: [
        { id: "native", name: "Native", kind: "native", ready: true },
        { id: "agy", name: "Antigravity", kind: "agy", ready: false, error: "Sign in required" },
        {
          id: "agy:acct-iso",
          name: "isolated@example.com",
          kind: "agy",
          ready: true,
          version: "1.5.18",
          accountEmail: "isolated@example.com",
          tier: "Pro",
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
        ready: false,
        status: "authentication_required",
        error: "Sign in required",
        modelCount: 0,
        loginPending: false,
        authorizationUrl: null,
      },
      {
        id: "acct-iso",
        agentId: "agy:acct-iso",
        label: "isolated@example.com",
        isDefault: false,
        authMethod: "oauth-personal",
        hasApiKey: false,
        ready: true,
        status: "ready",
        version: "1.5.18",
        accountEmail: "isolated@example.com",
        tier: "Pro",
        error: null,
        modelCount: 3,
        loginPending: false,
        authorizationUrl: null,
      },
    ];

    const authUrl = "https://accounts.google.com/o/oauth2/auth?response_type=code&state=s2";
    const api = {
      get: vi.fn(async (url: string) => {
        if (url === "/api/runtimes") return structuredClone(snapshot);
        if (url === "/api/runtimes/agy/accounts") return structuredClone(accounts);
        return [];
      }),
      post: vi.fn(async (url: string) => {
        if (url === "/api/runtimes/agy/accounts/default/login/start") {
          accounts[0].loginPending = true;
          accounts[0].authorizationUrl = authUrl;
          return {
            accountId: "default",
            agentId: "agy",
            flowId: "flow-2",
            authorizationUrl: authUrl,
            redirectUri: "https://antigravity.google/oauth-callback",
            state: "s2",
          };
        }
        if (url === "/api/runtimes/agy/accounts/default/login/cancel") {
          accounts[0].loginPending = false;
          accounts[0].authorizationUrl = null;
          return { success: true };
        }
        return { success: true };
      }),
      patch: vi.fn(async () => ({})),
      put: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({ success: true })),
    };

    const clipboardRead = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce("   ")
      .mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => {}), readText: clipboardRead },
    });

    const replaceMock = vi.fn();
    const focusMock = vi.fn();
    const fakePopup: { opener: unknown; location: { replace: ReturnType<typeof vi.fn> }; focus: ReturnType<typeof vi.fn> } = {
      opener: window,
      location: { replace: replaceMock },
      focus: focusMock,
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakePopup as unknown as Window);

    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="runtime-settings-tab"]').trigger("click");
    await flushPromises();

    // Detected runtimes reports Ready for Antigravity via the ready isolated account without adding a duplicate row.
    expect(wrapper.get('[data-testid="runtime-row-agy"]').text()).toContain("Ready");
    expect(wrapper.get('[data-testid="runtime-row-agy"]').text()).toContain("isolated@example.com · agy · v1.5.18");
    expect(wrapper.find('[data-testid="runtime-row-agy:acct-iso"]').exists()).toBe(false);

    // Start login on default account.
    await wrapper.get('[data-testid="agy-login-start-default"]').trigger("click");
    await flushPromises();
    expect(hasPendingAgyLoginView()).toBe(true);

    const link = wrapper.get('[data-testid="agy-login-link-default"]');

    // Primary click opens popup without `noopener` in features, clears opener, navigates, and prevents default.
    const primaryClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.element.dispatchEvent(primaryClick);
    expect(openSpy).toHaveBeenCalledWith("", "_blank", "popup=yes,width=540,height=720");
    expect(fakePopup.opener).toBeNull();
    expect(replaceMock).toHaveBeenCalledWith(authUrl);
    expect(focusMock).toHaveBeenCalled();
    expect(primaryClick.defaultPrevented).toBe(true);

    // Modifier click bypasses popup interception so browser handles background tab normally.
    openSpy.mockClear();
    const cmdClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
    link.element.dispatchEvent(cmdClick);
    expect(openSpy).not.toHaveBeenCalled();
    expect(cmdClick.defaultPrevented).toBe(false);

    // Blocked popup (returns null) lets `<a target="_blank">` default navigation proceed.
    openSpy.mockReturnValueOnce(null);
    const blockedClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.element.dispatchEvent(blockedClick);
    expect(blockedClick.defaultPrevented).toBe(false);

    // Empty clipboard and denied clipboard errors surface clearly.
    await wrapper.get('[data-testid="agy-login-paste-default"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Clipboard is empty.");
    await wrapper.get('[data-testid="agy-login-paste-default"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Clipboard read permission was denied.");

    // Cancel clears pending login state in localStorage.
    await wrapper.get('[data-testid="agy-login-cancel-default"]').trigger("click");
    await flushPromises();
    expect(hasPendingAgyLoginView()).toBe(false);

    // Verify 10-minute TTL expiry in agyPendingLogin helper.
    const baseNow = Date.now();
    markPendingAgyLoginView();
    expect(hasPendingAgyLoginView(baseNow + AGY_PENDING_LOGIN_TTL_MS - 1000)).toBe(true);
    expect(hasPendingAgyLoginView(baseNow + AGY_PENDING_LOGIN_TTL_MS + 1000)).toBe(false);
    clearPendingAgyLoginView();

    wrapper.unmount();
  });

  it("renders structured account header rows, grouped badges, and adjacent add-account divider anchor", async () => {
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
          tier: "Plus",
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
        tier: "Plus",
        error: null,
        modelCount: 5,
        loginPending: false,
        authorizationUrl: null,
      },
      {
        id: "api-key-acct",
        agentId: "agy:api-key-acct",
        label: "Gemini API Key",
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
      post: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      put: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    };

    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="runtime-settings-tab"]').trigger("click");
    await flushPromises();

    const defaultCard = wrapper.get('[data-testid="agy-account-row-default"]');
    expect(defaultCard.get(".agyAccountHeader .agyAccountTitle .agyAccountEmail").text()).toBe("host@example.com");
    expect(defaultCard.get(".agyAccountHeader .agyAccountBadges .accountTag").text()).toBe("Host default");
    expect(defaultCard.get(".agyAccountHeader .agyAccountBadges .tierBadge").text()).toBe("Plus");
    expect(defaultCard.get(".agyAccountHeader .agyAccountStatus").text()).toBe("Ready · 5 models");
    expect(defaultCard.get(".agyAccountHeader .agyAccountDetails .settingsDetail").text()).toContain(
      "Google OAuth (Personal) · agy",
    );
    expect(defaultCard.findAll(".agyAccountActions .agyActionBtn")).toHaveLength(2);

    const apiKeyCard = wrapper.get('[data-testid="agy-account-row-api-key-acct"]');
    expect(apiKeyCard.get(".agyAccountHeader .agyAccountTitle .agyAccountName").text()).toBe("Gemini API Key");
    expect(apiKeyCard.find(".agyAccountHeader .agyAccountBadges").exists()).toBe(false);
    expect(apiKeyCard.get(".agyAccountHeader .agyAccountStatus").text()).toBe("Ready · 1 model");

    const addButton = wrapper.get('[data-testid="agy-account-add"]');
    expect(addButton.classes()).toContain("settingsRow");
    expect(addButton.element.previousElementSibling).toBe(apiKeyCard.element);

    wrapper.unmount();
  });
});
