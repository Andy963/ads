import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import type { LanePromptSnapshot, ModelConfig } from "../api/types";
import ModelManager from "../components/ModelManager.vue";
import { readSfc } from "./readSfc";

function makeModel(
  id: string,
  displayName: string,
  provider: string,
  agent: string = "codex",
  modelId = id,
): ModelConfig {
  return {
    id,
    modelId,
    displayName,
    provider,
    isEnabled: true,
    isDefault: false,
    configJson: { allowedAgents: [agent] },
  };
}

async function settle(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

function touchPoint(clientX: number, clientY: number): { clientX: number; clientY: number } {
  return { clientX, clientY };
}

function stubMatchMedia(matches: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  return () => {
    if (original) window.matchMedia = original;
    else delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
  };
}

async function longPressRow(
  wrapper: { vm: { $nextTick: () => Promise<void> } } & { find: (selector: string) => { trigger: (name: string, payload?: unknown) => Promise<void> } },
  modelId: string,
): Promise<void> {
  vi.useFakeTimers();
  try {
    const row = wrapper.find(`[data-testid="model-manager-row-${modelId}"]`);
    await row.trigger("touchstart", { touches: [touchPoint(240, 120)] });
    vi.advanceTimersByTime(600);
    await settle(wrapper);
  } finally {
    vi.useRealTimers();
  }
}

describe("ModelManager", () => {
  it("prefills server metadata across remounts without persisting or returning an API key", async () => {
    localStorage.clear();
    const api = {
      get: vi.fn().mockImplementation((url: string) => Promise.resolve(url === "/api/models/upstream/config"
        ? { baseUrl: "https://saved.test/v1", provider: "custom", hasApiKey: true } : [])),
      post: vi.fn().mockResolvedValue({ ok: true, models: [] }), patch: vi.fn(), delete: vi.fn(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wrapper = mount(ModelManager, { props: { api: api as any }, global: { stubs: { "el-icon": true } } });
      await settle(wrapper);
      await wrapper.get('[data-testid="model-manager-sync"]').trigger("click");
      await settle(wrapper);
      expect((wrapper.get('[data-testid="model-manager-sync-base-url"]').element as HTMLInputElement).value).toBe("https://saved.test/v1");
      expect((wrapper.get('[data-testid="model-manager-sync-provider"]').element as HTMLInputElement).value).toBe("custom");
      const key = wrapper.get('[data-testid="model-manager-sync-api-key"]');
      expect((key.element as HTMLInputElement).value).toBe("");
      expect(key.attributes("placeholder")).toContain("configured on server");
      await wrapper.get('[data-testid="model-manager-sync-dialog"]').trigger("submit");
      await settle(wrapper);
      expect(api.post).toHaveBeenLastCalledWith("/api/models/upstream", { baseUrl: "https://saved.test/v1", provider: "custom" });
      await key.setValue("new-test-secret");
      await wrapper.get('[data-testid="model-manager-sync-dialog"]').trigger("submit");
      await settle(wrapper);
      expect((key.element as HTMLInputElement).value).toBe("");
      expect(JSON.stringify(localStorage)).not.toContain("new-test-secret");
      wrapper.unmount();
    }
    expect(api.get.mock.calls.filter(([url]) => url === "/api/models/upstream/config")).toHaveLength(2);
  });

  it("imports only checked discoveries and never reimports configured models", async () => {
    const existing = makeModel("existing", "Existing", "openai");
    const api = {
      get: vi.fn().mockImplementation((url: string) => Promise.resolve(url === "/api/model-configs" ? [existing] : {})),
      post: vi.fn().mockImplementation((url: string) => Promise.resolve(url === "/api/models/upstream"
        ? { ok: true, models: ["existing", "chosen", "ignored"] } : {})),
      patch: vi.fn(), delete: vi.fn(),
    };
    const wrapper = mount(ModelManager, { props: { api: api as any }, global: { stubs: { "el-icon": true } } });
    await settle(wrapper);
    await wrapper.get('[data-testid="model-manager-sync"]').trigger("click");
    await settle(wrapper);
    await wrapper.get('[data-testid="model-manager-sync-dialog"]').trigger("submit");
    await settle(wrapper);
    expect((wrapper.get('[data-testid="model-manager-sync-model-existing"]').element as HTMLInputElement).disabled).toBe(true);
    await wrapper.get('[data-testid="model-manager-sync-model-ignored"]').setValue(false);
    await wrapper.get('[data-testid="model-manager-sync-import"]').trigger("click");
    await settle(wrapper);
    const imports = api.post.mock.calls.filter(([url]) => url === "/api/model-configs");
    expect(imports).toHaveLength(1);
    expect(imports[0]?.[1]).toMatchObject({ modelId: "chosen" });
    expect(JSON.stringify(imports)).not.toContain("apiKey");
    wrapper.unmount();
  });

  it("edits versioned Advisor and Worker prompts", async () => {
    const advisorPrompt = "Advisor baseline prompt";
    const workerPrompt = "Worker baseline prompt";
    const snapshots: LanePromptSnapshot[] = [
      {
        lane: "acopilot",
        current: { lane: "acopilot", version: 1, prompt: advisorPrompt, isBase: true, createdAt: 1 },
        base: { lane: "acopilot", version: 1, prompt: advisorPrompt, isBase: true, createdAt: 1 },
        versions: [{ lane: "acopilot", version: 1, prompt: advisorPrompt, isBase: true, createdAt: 1 }],
        updatedAt: 1,
      },
      {
        lane: "actions",
        current: { lane: "actions", version: 1, prompt: workerPrompt, isBase: true, createdAt: 1 },
        base: { lane: "actions", version: 1, prompt: workerPrompt, isBase: true, createdAt: 1 },
        versions: [{ lane: "actions", version: 1, prompt: workerPrompt, isBase: true, createdAt: 1 }],
        updatedAt: 1,
      },
    ];
    const savedAdvisor = {
      ...snapshots[0],
      current: { ...snapshots[0].current, version: 2, prompt: "Custom advisor prompt", isBase: false },
      versions: [
        { ...snapshots[0].current, version: 2, prompt: "Custom advisor prompt", isBase: false },
        ...snapshots[0].versions,
      ],
    } as LanePromptSnapshot;
    const api = {
      get: vi.fn().mockImplementation((path: string) =>
        Promise.resolve(path === "/api/lane-prompts" ? snapshots : []),
      ),
      post: vi.fn().mockResolvedValue(snapshots[1]),
      patch: vi.fn(),
      put: vi.fn().mockResolvedValue(savedAdvisor),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any, initialTab: "lane-prompts" },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    expect((wrapper.find('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe(advisorPrompt);
    expect(wrapper.find('[data-testid="lane-prompt-save"]').attributes("disabled")).toBeDefined();

    await wrapper.find('[data-testid="lane-prompt-editor"]').setValue("Custom advisor prompt");
    await wrapper.find('[data-testid="lane-prompt-save"]').trigger("click");
    await settle(wrapper);
    expect(api.put).toHaveBeenCalledWith("/api/lane-prompts/acopilot", { prompt: "Custom advisor prompt" });
    expect(wrapper.find('[data-testid="lane-prompt-status"]').text()).toContain("已保存");
    expect(wrapper.find('[data-testid="lane-prompt-history"]').text()).toContain("当前生效：v2");
    expect(wrapper.find('[data-testid="lane-prompt-history"] details').exists()).toBe(false);

    await wrapper.find('[data-testid="lane-prompt-lane-developer"]').trigger("click");
    expect((wrapper.find('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe(workerPrompt);
    wrapper.unmount();
  });

  it("selects a historical prompt version and restores it as a new active version", async () => {
    const advisorBase = "Advisor baseline prompt";
    const advisorCustom = "Advisor custom prompt";
    const snapshots: LanePromptSnapshot[] = [
      {
        lane: "acopilot",
        current: { lane: "acopilot", version: 2, prompt: advisorCustom, isBase: false, createdAt: 2 },
        base: { lane: "acopilot", version: 1, prompt: advisorBase, isBase: true, createdAt: 1 },
        versions: [
          { lane: "acopilot", version: 2, prompt: advisorCustom, isBase: false, createdAt: 2 },
          { lane: "acopilot", version: 1, prompt: advisorBase, isBase: true, createdAt: 1 },
        ],
        updatedAt: 2,
      },
      {
        lane: "actions",
        current: { lane: "actions", version: 1, prompt: "Worker baseline prompt", isBase: true, createdAt: 1 },
        base: { lane: "actions", version: 1, prompt: "Worker baseline prompt", isBase: true, createdAt: 1 },
        versions: [{ lane: "actions", version: 1, prompt: "Worker baseline prompt", isBase: true, createdAt: 1 }],
        updatedAt: 1,
      },
    ];
    const restored = {
      ...snapshots[0],
      current: { lane: "acopilot", version: 3, prompt: advisorBase, isBase: false, createdAt: 3 },
      versions: [
        { lane: "acopilot", version: 3, prompt: advisorBase, isBase: false, createdAt: 3 },
        ...snapshots[0].versions,
      ],
      updatedAt: 3,
    } satisfies LanePromptSnapshot;
    const api = {
      get: vi.fn().mockImplementation((path: string) =>
        Promise.resolve(path === "/api/lane-prompts" ? snapshots : []),
      ),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn().mockResolvedValue(restored),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any, initialTab: "lane-prompts" },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    const versionSelect = wrapper.find('[data-testid="lane-prompt-version-select"]');
    expect(versionSelect.findAll("option").map((option) => option.text())).toEqual([
      expect.stringContaining("当前生效"),
      expect.stringContaining("初始默认"),
    ]);

    await versionSelect.setValue(1);
    await settle(wrapper);
    expect((wrapper.find('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe(advisorBase);
    expect(wrapper.find('[data-testid="lane-prompt-version-notice"]').text()).toContain("当前生效版本为 v2");
    expect(wrapper.find('[data-testid="lane-prompt-restore"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-prompt-save"]').attributes("disabled")).toBeDefined();

    await wrapper.find('[data-testid="lane-prompt-restore"]').trigger("click");
    await settle(wrapper);
    expect(api.put).toHaveBeenCalledWith("/api/lane-prompts/acopilot", { prompt: advisorBase });
    expect((wrapper.find('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe(advisorBase);
    expect(wrapper.find('[data-testid="lane-prompt-history"]').text()).toContain("当前生效：v3");
    expect(wrapper.find('[data-testid="lane-prompt-version-notice"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="lane-prompt-status"]').text()).toContain("已恢复 v1");

    wrapper.unmount();
  });

  it("switches between the prompt and model configuration settings tabs", async () => {
    const api = {
      get: vi.fn().mockImplementation((path: string) =>
        Promise.resolve(path === "/api/model-configs" ? [makeModel("gpt-5.2", "GPT 5.2", "openai")] : []),
      ),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any, initialTab: "lane-prompts" },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    expect(wrapper.find('[data-testid="settings-tab-prompts"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.find('[data-testid="lane-prompt-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="settings-models-panel"]').exists()).toBe(false);

    await wrapper.find('[data-testid="settings-tab-models"]').trigger("click");
    expect(wrapper.find('[data-testid="settings-models-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-prompt-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="settings-tab-models"]').attributes("aria-selected")).toBe("true");

    wrapper.unmount();
  });

  it("can hide the desktop header for embedded mobile navigation", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude")]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any, showHeader: false },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    expect(wrapper.find(".modelHeader").exists()).toBe(false);
    expect(wrapper.find(".cliList").exists()).toBe(true);
  });

  it("lists models in a flat list and creates a model", async () => {
    const createdModel = makeModel("model-generated", "gpt-5.2", "openai", "codex", "gpt-5.2");
    const initialModels = [
      makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude"),
      {
        id: "local-model",
        displayName: "Local Model",
        provider: "local",
        isEnabled: true,
        isDefault: false,
        configJson: null,
      } satisfies ModelConfig,
    ];
    const api = {
      get: vi.fn().mockImplementation(() =>
        Promise.resolve(apiConfigResponses.shift() ?? [makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude"), createdModel]),
      ),
      post: vi.fn().mockResolvedValue(createdModel),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const apiConfigResponses: ModelConfig[][] = [initialModels];

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    expect(api.get).toHaveBeenCalledWith("/api/model-configs");

    // Flat list of all models.
    const rows = wrapper.findAll(".modelRow");
    expect(rows).toHaveLength(2);
    expect(wrapper.text()).toContain("Claude Sonnet");
    expect(wrapper.text()).toContain("Local Model");

    // Adding starts from the add button.
    await wrapper.find('[data-testid="model-manager-add"]').trigger("click");
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(true);

    await wrapper.find('[data-testid="model-manager-model-id"]').setValue("gpt-5.2");
    await wrapper.find('[data-testid="model-manager-config-json"]').setValue('{"reasoningEffort":"high"}');
    await wrapper.find('[data-testid="model-manager-save"]').trigger("submit");
    await settle(wrapper);

    expect(api.post).toHaveBeenCalledWith("/api/model-configs", {
      modelId: "gpt-5.2",
      displayName: "gpt-5.2",
      provider: "openai",
      isEnabled: true,
      isDefault: false,
      configJson: {
        reasoningEffort: "high",
        allowedAgents: ["codex"],
      },
    });
    expect(wrapper.find('[data-testid="model-manager-status"]').text()).toContain("模型已添加");
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("does not duplicate a model id when no distinct display name is configured", async () => {
    const modelId = "gpt-image-2.5-sunburst-long-model-name";
    const api = {
      get: vi.fn().mockResolvedValue([makeModel(modelId, modelId, "openai")]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    const row = wrapper.find(`[data-testid="model-manager-row-${modelId}"]`);
    expect(row.find(".modelRowText").text()).toBe(modelId);
    expect(row.find(".modelRowId").exists()).toBe(false);

    wrapper.unmount();
  });

  it("reveals the row swipe actions on a horizontal swipe and snaps back on a right swipe", async () => {
    const model = makeModel("mobile-model", "Mobile Model", "openai");
    const api = {
      get: vi.fn().mockResolvedValue([model]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue({ success: true }),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    const row = wrapper.find('[data-testid="model-manager-row-mobile-model"]');
    const shell = wrapper.find(".modelRowSwipe");
    const swipeActions = wrapper.find(".modelSwipeActions");

    expect(swipeActions.classes()).not.toContain("actionVisible");

    await row.trigger("touchstart", { touches: [touchPoint(240, 120)] });
    await row.trigger("touchmove", { touches: [touchPoint(242, 220)] });
    await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(242, 220)] });
    await settle(wrapper);
    expect(shell.classes()).not.toContain("revealed");
    expect(swipeActions.classes()).not.toContain("actionVisible");

    await row.trigger("touchstart", { touches: [touchPoint(300, 120)] });
    await row.trigger("touchmove", { touches: [touchPoint(100, 122)] });
    await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(100, 122)] });
    await settle(wrapper);

    expect(shell.classes()).toContain("revealed");
    expect(row.attributes("style")).toContain("translateX(-204px)");
    expect(swipeActions.classes()).toContain("actionVisible");
    expect(wrapper.find('[data-testid="model-manager-swipe-edit-mobile-model"]').attributes("tabindex")).toBe("0");
    expect(wrapper.find('[data-testid="model-manager-swipe-copy-mobile-model"]').attributes("tabindex")).toBe("0");
    expect(wrapper.find('[data-testid="model-manager-swipe-delete-mobile-model"]').attributes("tabindex")).toBe("0");

    await row.trigger("touchstart", { touches: [touchPoint(100, 120)] });
    await row.trigger("touchmove", { touches: [touchPoint(300, 122)] });
    await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(300, 122)] });
    await settle(wrapper);

    expect(shell.classes()).not.toContain("revealed");
    expect(row.attributes("style")).toContain("translateX(0px)");
    expect(swipeActions.classes()).not.toContain("actionVisible");

    await row.trigger("touchstart", { touches: [touchPoint(300, 120)] });
    await row.trigger("touchmove", { touches: [touchPoint(100, 122)] });
    await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(100, 122)] });
    await settle(wrapper);
    await wrapper.find('[data-testid="model-manager-swipe-delete-mobile-model"]').trigger("click");
    await settle(wrapper);

    // The swipe gesture itself is the confirmation threshold: delete fires immediately.
    expect(api.delete).toHaveBeenCalledWith("/api/model-configs/mobile-model");
    expect(shell.classes()).not.toContain("revealed");
    expect(wrapper.find('[data-testid="model-manager-delete-confirm-mobile-model"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("确定删除？");

    wrapper.unmount();
  });

  it("runs edit and copy from the swipe actions", async () => {
    const model = makeModel("swipe-actions", "Swipe Actions", "openai");
    const api = {
      get: vi.fn().mockResolvedValue([model]),
      post: vi.fn().mockResolvedValue({}),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    const row = wrapper.find('[data-testid="model-manager-row-swipe-actions"]');
    const reveal = async () => {
      await row.trigger("touchstart", { touches: [touchPoint(300, 120)] });
      await row.trigger("touchmove", { touches: [touchPoint(100, 122)] });
      await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(100, 122)] });
      await settle(wrapper);
    };

    // Edit opens the prefilled dialog and closes the swipe.
    await reveal();
    await wrapper.find('[data-testid="model-manager-swipe-edit-swipe-actions"]').trigger("click");
    await settle(wrapper);
    expect(wrapper.find(".modelRowSwipe").classes()).not.toContain("revealed");
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="model-manager-model-id"]').element as HTMLInputElement).value).toBe("swipe-actions");
    await wrapper.find(".btnSecondary").trigger("click");
    await settle(wrapper);

    // Copy opens the create dialog prefilled from the row and posts a new model.
    await reveal();
    await wrapper.find('[data-testid="model-manager-swipe-copy-swipe-actions"]').trigger("click");
    await settle(wrapper);
    expect(wrapper.find(".modelRowSwipe").classes()).not.toContain("revealed");
    expect(wrapper.find('[data-testid="model-manager-dialog"]').text()).toContain("新增模型");
    expect((wrapper.find('[data-testid="model-manager-model-id"]').element as HTMLInputElement).value).toBe("swipe-actions-copy");
    await wrapper.find('[data-testid="model-manager-save"]').trigger("submit");
    await settle(wrapper);
    expect(api.post).toHaveBeenCalledWith(
      "/api/model-configs",
      expect.objectContaining({ modelId: "swipe-actions-copy", isDefault: false }),
    );

    wrapper.unmount();
  });

  it("keeps the swipe actions hidden until the row is dragged past half the actions width", async () => {
    const model = makeModel("swipe-threshold", "Swipe Threshold", "openai");
    const api = {
      get: vi.fn().mockResolvedValue([model]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    const row = wrapper.find('[data-testid="model-manager-row-swipe-threshold"]');
    const shell = wrapper.find(".modelRowSwipe");
    const swipeActions = wrapper.find(".modelSwipeActions");

    // A shallow drag (-60px, under the 102px halfway mark) never surfaces the actions.
    await row.trigger("touchstart", { touches: [touchPoint(300, 120)] });
    await row.trigger("touchmove", { touches: [touchPoint(240, 122)] });
    await settle(wrapper);
    expect(row.attributes("style")).toContain("translateX(-60px)");
    expect(swipeActions.classes()).not.toContain("actionVisible");
    await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(240, 122)] });
    await settle(wrapper);
    expect(shell.classes()).not.toContain("revealed");
    expect(row.attributes("style")).toContain("translateX(0px)");
    expect(swipeActions.classes()).not.toContain("actionVisible");

    // Past halfway (-120px) the actions fade in while dragging and stay once revealed.
    await row.trigger("touchstart", { touches: [touchPoint(300, 120)] });
    await row.trigger("touchmove", { touches: [touchPoint(180, 122)] });
    await settle(wrapper);
    expect(row.attributes("style")).toContain("translateX(-120px)");
    expect(swipeActions.classes()).toContain("actionVisible");
    await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(180, 122)] });
    await settle(wrapper);
    expect(shell.classes()).toContain("revealed");
    expect(row.attributes("style")).toContain("translateX(-204px)");
    expect(swipeActions.classes()).toContain("actionVisible");

    wrapper.unmount();
  });

  it("opens a long-press action sheet whose items run the row actions", async () => {
    const model = makeModel("sheet-model", "Sheet Model", "openai");
    const api = {
      get: vi.fn().mockResolvedValue([model]),
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue({ ...model, isDefault: true }),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    const sheet = () => document.querySelector('[data-testid="model-action-sheet"]');
    const sheetItem = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
    const row = wrapper.find('[data-testid="model-manager-row-sheet-model"]');

    // A quick tap-short touch never opens the sheet; a 500ms hold does.
    vi.useFakeTimers();
    try {
      await row.trigger("touchstart", { touches: [touchPoint(240, 120)] });
      vi.advanceTimersByTime(300);
      await settle(wrapper);
      expect(sheet()).toBeNull();
      await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(240, 120)] });
      await row.trigger("touchstart", { touches: [touchPoint(240, 120)] });
      vi.advanceTimersByTime(600);
      await settle(wrapper);
      expect(sheet()).not.toBeNull();

      // The synthetic click after the long-press must be swallowed.
      await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(240, 120)] });
      await row.trigger("click");
      expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);
      expect(row.classes()).not.toContain("selected");
    } finally {
      vi.useRealTimers();
    }

    // 编辑 opens the prefilled dialog and closes the sheet.
    sheetItem("model-action-sheet-edit")?.click();
    await settle(wrapper);
    expect(sheet()).toBeNull();
    expect((wrapper.find('[data-testid="model-manager-model-id"]').element as HTMLInputElement).value).toBe("sheet-model");
    await wrapper.find(".btnSecondary").trigger("click");
    await settle(wrapper);

    // 设为默认 patches the row and closes the sheet.
    await longPressRow(wrapper, "sheet-model");
    sheetItem("model-action-sheet-default")?.click();
    await settle(wrapper);
    await settle(wrapper);
    expect(sheet()).toBeNull();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/sheet-model", { isDefault: true });

    // 删除 deletes immediately — the explicit sheet tap is the confirmation step.
    await longPressRow(wrapper, "sheet-model");
    sheetItem("model-action-sheet-delete")?.click();
    await settle(wrapper);
    expect(sheet()).toBeNull();
    expect(api.delete).toHaveBeenCalledWith("/api/model-configs/sheet-model");
    expect(wrapper.find('[data-testid="model-manager-delete-confirm-sheet-model"]').exists()).toBe(false);

    // 取消 simply dismisses the sheet.
    await longPressRow(wrapper, "sheet-model");
    sheetItem("model-action-sheet-cancel")?.click();
    await settle(wrapper);
    expect(sheet()).toBeNull();

    wrapper.unmount();
    expect(document.querySelector('[data-testid="model-action-sheet"]')).toBeNull();
  });

  it("disables default-model actions in the swipe group and action sheet", async () => {
    const defaultModel = { ...makeModel("gpt-5.2", "GPT 5.2", "openai", "codex"), isDefault: true };
    const api = {
      get: vi.fn().mockResolvedValue([defaultModel]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    const row = wrapper.find('[data-testid="model-manager-row-gpt-5.2"]');
    await row.trigger("touchstart", { touches: [touchPoint(300, 120)] });
    await row.trigger("touchmove", { touches: [touchPoint(100, 122)] });
    await row.trigger("touchend", { touches: [], changedTouches: [touchPoint(100, 122)] });
    await settle(wrapper);

    expect(wrapper.find(".modelRowSwipe").classes()).toContain("revealed");
    expect(wrapper.find('[data-testid="model-manager-swipe-delete-gpt-5.2"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="model-manager-swipe-edit-gpt-5.2"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-testid="model-manager-swipe-copy-gpt-5.2"]').attributes("disabled")).toBeUndefined();

    await longPressRow(wrapper, "gpt-5.2");
    const sheetDefault = document.querySelector('[data-testid="model-action-sheet-default"]') as HTMLButtonElement;
    const sheetDelete = document.querySelector('[data-testid="model-action-sheet-delete"]') as HTMLButtonElement;
    const sheetEdit = document.querySelector('[data-testid="model-action-sheet-edit"]') as HTMLButtonElement;
    expect(sheetDefault.disabled).toBe(true);
    expect(sheetDelete.disabled).toBe(true);
    expect(sheetEdit.disabled).toBe(false);
    (document.querySelector('[data-testid="model-action-sheet-cancel"]') as HTMLElement).click();
    await settle(wrapper);

    wrapper.unmount();
  });

  it("opens the edit dialog on a mobile row tap and keeps row selection on desktop", async () => {
    const model = makeModel("tap-model", "Tap Model", "openai");
    const api = {
      get: vi.fn().mockResolvedValue([model]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const restoreMobile = stubMatchMedia(true);
    const mobileWrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(mobileWrapper);
    await mobileWrapper.find('[data-testid="model-manager-row-tap-model"]').trigger("click");
    expect(mobileWrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(true);
    expect((mobileWrapper.find('[data-testid="model-manager-model-id"]').element as HTMLInputElement).value).toBe("tap-model");
    mobileWrapper.unmount();
    restoreMobile();

    const restoreDesktop = stubMatchMedia(false);
    const desktopWrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(desktopWrapper);
    const desktopRow = desktopWrapper.find('[data-testid="model-manager-row-tap-model"]');
    await desktopRow.trigger("click");
    expect(desktopWrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);
    expect(desktopRow.classes()).toContain("selected");
    desktopWrapper.unmount();
    restoreDesktop();
  });

  it("keeps row cards opaque and gates the swipe actions behind the visibility class", async () => {
    const css = await readSfc("../components/ModelManager.vue", import.meta.url);

    const swipeActions = css.match(/\.modelSwipeActions\s*\{[^}]*\}/)?.[0];
    expect(swipeActions).toMatch(/width:\s*204px\s*;/);
    expect(swipeActions).toMatch(/opacity:\s*0\s*;/);
    expect(swipeActions).toMatch(/visibility:\s*hidden\s*;/);
    expect(swipeActions).toMatch(/pointer-events:\s*none\s*;/);

    const swipeActionsVisible = css.match(/\.modelSwipeActions\.actionVisible\s*\{[^}]*\}/)?.[0];
    expect(swipeActionsVisible).toMatch(/opacity:\s*1\s*;/);
    expect(swipeActionsVisible).toMatch(/visibility:\s*visible\s*;/);
    expect(swipeActionsVisible).toMatch(/pointer-events:\s*auto\s*;/);

    expect(css).toMatch(/\.modelSwipeAction\.delete\s*\{[^}]*background:\s*var\(--danger-2\)\s*;/);

    // Row backgrounds layer the translucent tint over an opaque surface so the
    // hidden swipe actions never show through hover/selected states.
    const hover = css.match(/\.modelRow:hover\s*\{[^}]*\}/)?.[0];
    expect(hover).toBeTruthy();
    expect(hover).not.toMatch(/background:\s*rgba\(/);
    expect(hover).toContain("var(--surface)");

    const selected = css.match(/\.modelRow\.selected\s*\{[^}]*\}/)?.[0];
    expect(selected).toBeTruthy();
    expect(selected).not.toMatch(/background:\s*rgba\(/);
    expect(selected).toContain("var(--surface)");
    expect(selected).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--accent\)\s*;/);

    const selectedHover = css.match(/\.modelRow\.selected:hover\s*\{[^}]*\}/)?.[0];
    expect(selectedHover).toBeTruthy();
    expect(selectedHover).not.toMatch(/background:\s*rgba\(/);
    expect(selectedHover).toContain("var(--surface)");

    // Busy rows dim their contents, never the card itself.
    expect(css).not.toMatch(/\.modelRow\.busy\s*\{[^}]*opacity/);
  });

  it("keeps mobile rows free of persistent inline action buttons", async () => {
    const css = await readSfc("../components/ModelManager.vue", import.meta.url);

    // The v2 persistent big-button cluster (and its text labels) is gone.
    expect(css).not.toContain("rowActionLabel");

    const mobileStart = css.indexOf("@media (max-width: 900px)");
    expect(mobileStart).toBeGreaterThan(-1);
    const mobileCss = css.slice(mobileStart);

    expect(mobileCss).toMatch(/\.modelRowActions\s*\{\s*display:\s*none\s*;/);
    expect(mobileCss).not.toMatch(/\.modelRowActions\s+\.rowAction\s*\{/);
    // The inline delete-confirmation bar is gone — swipe and sheet delete fire immediately.
    expect(css).not.toContain("modelRowActions.pending");
    expect(mobileCss).toMatch(/\.rowSwitch\s*\{[^}]*min-height:\s*40px\s*;/);

    // Dialog footer buttons become equal-width thumb targets with a 44px floor.
    // (jsdom never evaluates media queries, so this stays a source-level assertion.)
    const dialogActionsButtons = mobileCss.match(
      /\.dialogActions\s+\.btnSecondary,\s*\.dialogActions\s+\.btnPrimary\s*\{[^}]*\}/,
    )?.[0];
    expect(dialogActionsButtons).toBeTruthy();
    expect(dialogActionsButtons).toMatch(/flex:\s*1\s*;/);
    expect(dialogActionsButtons).toMatch(/min-height:\s*44px\s*;/);

    // Desktop keeps the compact icon buttons and the flush switch alignment.
    expect(css).toMatch(/\.rowAction\.icon\s*\{[^}]*width:\s*30px\s*;/);
    expect(css).toMatch(/\.rowSwitch\s*\{[^}]*margin-right:\s*-3px\s*;/);
  });

  it("edits in a dialog and deletes directly from the row", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude")]),
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue(makeModel("claude-sonnet", "Claude Opus", "anthropic", "claude")),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue({ success: true }),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);

    await wrapper.find('[data-testid="model-manager-edit-claude-sonnet"]').trigger("click");
    const dialog = wrapper.find('[data-testid="model-manager-dialog"]');
    expect(dialog.exists()).toBe(true);
    // Config JSON is a plain field in the dialog, not a collapsed section.
    expect(dialog.find("details").exists()).toBe(false);
    expect(dialog.find('[data-testid="model-manager-config-json"]').exists()).toBe(true);

    // The dialog is edit-only: no delete entrance and no header close button
    // duplicating the footer cancel.
    expect(dialog.find('[data-testid="model-manager-dialog-delete"]').exists()).toBe(false);
    expect(dialog.find('[data-testid="model-manager-dialog-delete-confirm"]').exists()).toBe(false);
    expect(dialog.find('[data-testid="model-manager-dialog-delete-cancel"]').exists()).toBe(false);
    expect(dialog.find(".dialogHeader button").exists()).toBe(false);
    const footerButtons = dialog.find(".dialogActions").findAll("button");
    expect(footerButtons.map((button) => button.text())).toEqual(["取消", "保存模型"]);

    await wrapper.find('[data-testid="model-manager-model-id"]').setValue("claude-opus");
    await wrapper.find('[data-testid="model-manager-display-name"]').setValue("Claude Opus");
    await wrapper.find('[data-testid="model-manager-save"]').trigger("submit");
    await settle(wrapper);

    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/claude-sonnet", {
      modelId: "claude-opus",
      displayName: "Claude Opus",
      provider: "anthropic",
      isEnabled: true,
      isDefault: false,
      configJson: { allowedAgents: ["codex"] },
    });
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);

    // The row delete icon deletes immediately — no inline confirmation step.
    expect(wrapper.find('[data-testid="model-manager-delete-claude-sonnet"]').exists()).toBe(true);
    await wrapper.find('[data-testid="model-manager-delete-claude-sonnet"]').trigger("click");
    await settle(wrapper);

    expect(api.delete).toHaveBeenCalledWith("/api/model-configs/claude-sonnet");
    expect(wrapper.find('[data-testid="model-manager-delete-confirm-claude-sonnet"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("确定删除？");

    wrapper.unmount();
  });

  it("offers no delete entrance while creating a model", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude")]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    await wrapper.find('[data-testid="model-manager-add"]').trigger("click");
    const dialog = wrapper.find('[data-testid="model-manager-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("新增模型");
    expect(dialog.find('[data-testid="model-manager-dialog-delete"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("surfaces a save failure inside the dialog instead of behind the mask", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([]),
      post: vi.fn().mockRejectedValue(new Error("model id already exists")),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    await wrapper.find('[data-testid="model-manager-add"]').trigger("click");
    await wrapper.find('[data-testid="model-manager-model-id"]').setValue("gpt-5.2");
    await wrapper.find('[data-testid="model-manager-save"]').trigger("submit");
    await settle(wrapper);

    // The dialog stays open so the value is not lost, and the error renders within it.
    const dialog = wrapper.find('[data-testid="model-manager-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.find('[data-testid="model-manager-dialog-error"]').text()).toContain("model id already exists");
    // The page-level banner would be covered by the mask, so it must not be the only signal.
    expect(wrapper.find('[data-testid="model-manager-error"]').exists()).toBe(false);
    expect(wrapper.emitted("changed")).toBeUndefined();

    wrapper.unmount();
  });

  it("never lets the global default be un-defaulted or disabled", async () => {
    const defaultModel = { ...makeModel("gpt-5.2", "GPT 5.2", "openai", "codex"), isDefault: true };
    const api = {
      get: vi.fn().mockResolvedValue([defaultModel]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    // The row switch cannot disable it — nothing would replace it in the composer dropdown.
    const toggle = wrapper.find('[data-testid="model-manager-toggle-gpt-5.2"]');
    expect(toggle.attributes("disabled")).toBeDefined();
    await toggle.trigger("click");
    await settle(wrapper);
    expect(api.patch).not.toHaveBeenCalled();

    // Neither can the dialog: the server writes isDefault:false verbatim without picking a successor.
    await wrapper.find('[data-testid="model-manager-edit-gpt-5.2"]').trigger("click");
    expect(wrapper.find('[data-testid="model-manager-default"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="model-manager-enabled"]').attributes("disabled")).toBeDefined();
    // The edit dialog no longer carries a delete entrance at all.
    expect(wrapper.find('[data-testid="model-manager-dialog-delete"]').exists()).toBe(false);
    await wrapper.find('.btnSecondary').trigger("click");

    // Deleting is already blocked on the row, so the default can only ever be moved to another model.
    expect(wrapper.find('[data-testid="model-manager-delete-gpt-5.2"]').attributes("disabled")).toBeDefined();

    wrapper.unmount();
  });

  it("switches default and enabled state from the row without opening the dialog", async () => {
    const codexModel = makeModel("gpt-5.2", "GPT 5.2", "openai", "codex");
    const api = {
      get: vi.fn().mockResolvedValue([codexModel]),
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue(codexModel),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    await wrapper.find('[data-testid="model-manager-toggle-gpt-5.2"]').trigger("click");
    await settle(wrapper);
    await settle(wrapper);

    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/gpt-5.2", { isEnabled: false });
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);

    await wrapper.find('[data-testid="model-manager-default-gpt-5.2"]').trigger("click");
    await settle(wrapper);
    await settle(wrapper);

    expect(api.patch).toHaveBeenLastCalledWith("/api/model-configs/gpt-5.2", { isDefault: true });
    expect(wrapper.emitted("changed")).toHaveLength(2);
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("duplicates a model from the row copy action with isDefault forced off", async () => {
    const source = {
      ...makeModel("gpt-5.2", "GPT 5.2", "openai", "codex"),
      isDefault: true,
      configJson: { reasoningEffort: "high", allowedAgents: ["codex"] },
    };
    const existingCopy = makeModel("gpt-5.2-copy", "GPT 5.2 (Copy)", "openai", "codex", "gpt-5.2-copy");
    const api = {
      get: vi.fn().mockResolvedValue([source, existingCopy]),
      post: vi.fn().mockResolvedValue({}),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    const copyButton = wrapper.find('[data-testid="model-manager-copy-gpt-5.2"]');
    expect(copyButton.exists()).toBe(true);
    await copyButton.trigger("click");
    await settle(wrapper);

    const dialog = wrapper.find('[data-testid="model-manager-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("新增模型");
    expect((wrapper.find('[data-testid="model-manager-model-id"]').element as HTMLInputElement).value).toBe("gpt-5.2-copy-2");
    expect((wrapper.find('[data-testid="model-manager-display-name"]').element as HTMLInputElement).value).toBe("GPT 5.2 (Copy)");
    expect((wrapper.find('[data-testid="model-manager-default"]').element as HTMLInputElement).checked).toBe(false);
    expect((wrapper.find('[data-testid="model-manager-enabled"]').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.find('[data-testid="model-manager-config-json"]').element as HTMLTextAreaElement).value).toContain(
      '"reasoningEffort": "high"',
    );

    await wrapper.find('[data-testid="model-manager-save"]').trigger("submit");
    await settle(wrapper);

    expect(api.post).toHaveBeenCalledWith("/api/model-configs", {
      modelId: "gpt-5.2-copy-2",
      displayName: "GPT 5.2 (Copy)",
      provider: "openai",
      isEnabled: true,
      isDefault: false,
      configJson: { reasoningEffort: "high", allowedAgents: ["codex"] },
    });
    expect(api.patch).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("discovers and imports selected upstream models without adding autocomplete", async () => {
    const existingModel = makeModel("existing-model", "Existing Model", "openai", "codex", "existing-model");
    const api = {
      get: vi.fn().mockImplementation((path: string) =>
        Promise.resolve(path === "/api/model-configs" ? [existingModel] : []),
      ),
      post: vi.fn().mockImplementation((path: string) => {
        if (path === "/api/models/upstream") {
          return Promise.resolve({ ok: true, models: ["gpt-5.6-sol", "existing-model"] });
        }
        return Promise.resolve({});
      }),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    await wrapper.find('[data-testid="model-manager-sync"]').trigger("click");
    expect(wrapper.find('[data-testid="model-manager-sync-dialog"]').exists()).toBe(true);
    await wrapper.find('[data-testid="model-manager-sync-base-url"]').setValue("https://provider.test/v1");
    await wrapper.find('[data-testid="model-manager-sync-api-key"]').setValue("sk-test");
    await wrapper.find('[data-testid="model-manager-sync-provider"]').setValue("custom");
    await wrapper.find('[data-testid="model-manager-sync-dialog"]').trigger("submit");
    await settle(wrapper);

    expect(api.post).toHaveBeenCalledWith("/api/models/upstream", {
      baseUrl: "https://provider.test/v1",
      apiKey: "sk-test",
      provider: "custom",
    });
    expect(wrapper.find('[data-testid="model-manager-sync-model-gpt-5.6-sol"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="model-manager-sync-model-existing-model"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="model-manager-sync-import"]').text()).toContain("导入 1 个模型");

    await wrapper.find('[data-testid="model-manager-sync-import"]').trigger("click");
    await settle(wrapper);

    expect(api.post).toHaveBeenCalledWith("/api/model-configs", {
      modelId: "gpt-5.6-sol",
      displayName: "gpt-5.6-sol",
      provider: "custom",
      isEnabled: true,
      isDefault: false,
      configJson: { allowedAgents: ["codex"] },
    });
    expect(wrapper.find('[data-testid="model-manager-sync-dialog"]').exists()).toBe(false);
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.find("datalist").exists()).toBe(false);

    wrapper.unmount();
  });

  it("preserves lane prompt edits in memory when switching lanes", async () => {
    const api = {
      get: vi.fn().mockImplementation(async (url: string) => {
        if (url === "/api/lane-prompts") {
          return [
            {
              lane: "acopilot",
              current: { lane: "acopilot", version: 1, prompt: "Advisor original prompt" },
              versions: [{ lane: "acopilot", version: 1, prompt: "Advisor original prompt" }],
            },
            {
              lane: "actions",
              current: { lane: "actions", version: 1, prompt: "Worker original prompt" },
              versions: [{ lane: "actions", version: 1, prompt: "Worker original prompt" }],
            },
          ];
        }
        if (url === "/api/model-configs") return [];
        return [];
      }),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };

    const wrapper = mount(ModelManager, {
      props: {
        api,
        initialTab: "lane-prompts",
      },
    });
    await settle(wrapper);

    const textarea = wrapper.find('[data-testid="lane-prompt-editor"]');
    await textarea.setValue("Modified Advisor draft text");

    // Switch to worker
    await wrapper.find('[data-testid="lane-prompt-lane-developer"]').trigger("click");
    await settle(wrapper);
    expect((wrapper.find('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe("Worker original prompt");

    // Switch back to advisor
    await wrapper.find('[data-testid="lane-prompt-lane-acopilot"]').trigger("click");
    await settle(wrapper);
    expect((wrapper.find('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe("Modified Advisor draft text");

    wrapper.unmount();
  });

  it("supports three-role segmented selection across Acopilot, Developer, and Reviewer with role controls", async () => {
    const roleProfiles = [
      {
        id: "profile-acopilot",
        role: "acopilot",
        name: "Acopilot Default",
        model_id: "gpt-5.5",
        reasoning_effort: "high",
        system_prompt: "Acopilot Prompt",
        is_enabled: 1,
        is_default: 1,
        version: 1,
      },
      {
        id: "profile-developer",
        role: "developer",
        name: "Developer Default",
        model_id: "gpt-5.5",
        reasoning_effort: "high",
        system_prompt: "Developer Prompt",
        is_enabled: 1,
        is_default: 1,
        version: 1,
      },
      {
        id: "profile-reviewer",
        role: "reviewer",
        name: "Reviewer Default",
        model_id: "gpt-5.5",
        reasoning_effort: "high",
        system_prompt: "Reviewer Untrusted Diff Prompt",
        is_enabled: 1,
        is_default: 1,
        version: 1,
      },
    ];

    const api = {
      get: vi.fn().mockImplementation((url: string) => {
        if (url === "/api/role-profiles") return Promise.resolve(roleProfiles);
        if (url === "/api/models") return Promise.resolve([makeModel("m1", "GPT 5.5", "openai", "codex", "gpt-5.5")]);
        if (url === "/api/lane-prompts") return Promise.resolve([]);
        return Promise.resolve([]);
      }),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };

    const wrapper = mount(ModelManager, {
      props: {
        api,
        initialTab: "roles",
      },
    });
    await settle(wrapper);

    // Verify 3 role buttons exist
    expect(wrapper.find('[data-testid="lane-prompt-lane-acopilot"]').text()).toContain("Acopilot");
    expect(wrapper.find('[data-testid="lane-prompt-lane-developer"]').text()).toContain("Developer");
    expect(wrapper.find('[data-testid="lane-prompt-lane-reviewer"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-prompt-lane-reviewer"]').text()).toContain("Reviewer");

    // Verify model and effort controls
    expect(wrapper.find('[data-testid="role-model-select"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="role-effort-select"]').exists()).toBe(true);
    expect(wrapper.find('.roleControlsBar').text()).toContain("模型");
    expect(wrapper.find('.roleControlsBar').text()).toContain("思考");

    // Switch to Reviewer
    await wrapper.find('[data-testid="lane-prompt-lane-reviewer"]').trigger("click");
    await settle(wrapper);
    expect((wrapper.find('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe("Reviewer Untrusted Diff Prompt");

    wrapper.unmount();
  });

  it("marks role model changes dirty, persists them, and surfaces save failures", async () => {
    const prompt = "Acopilot Prompt";
    const roleProfile = {
      id: "profile-acopilot",
      role: "acopilot",
      name: "Acopilot Default",
      model_id: "gpt-5.5",
      reasoning_effort: "high",
      system_prompt: prompt,
      is_enabled: 1,
      is_default: 1,
      version: 1,
    };
    const snapshot: LanePromptSnapshot = {
      lane: "acopilot",
      current: { lane: "acopilot", version: 1, prompt, isBase: true, createdAt: 1 },
      base: { lane: "acopilot", version: 1, prompt, isBase: true, createdAt: 1 },
      versions: [{ lane: "acopilot", version: 1, prompt, isBase: true, createdAt: 1 }],
      updatedAt: 1,
    };
    const models = [
      makeModel("m1", "GPT 5.5", "openai", "codex", "gpt-5.5"),
      makeModel("m2", "GPT 5.6", "openai", "codex", "gpt-5.6"),
    ];
    let failRoleSave = false;
    const api = {
      get: vi.fn().mockImplementation((url: string) => {
        if (url === "/api/model-configs") return Promise.resolve(models);
        if (url === "/api/role-profiles") return Promise.resolve([roleProfile]);
        if (url === "/api/lane-prompts") return Promise.resolve([snapshot]);
        return Promise.resolve([]);
      }),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockImplementation((url: string, body: Record<string, unknown>) => {
        if (url.startsWith("/api/role-profiles/") && failRoleSave) {
          return Promise.reject(new Error("role profile save failed"));
        }
        if (url.startsWith("/api/role-profiles/")) {
          return Promise.resolve({ ...roleProfile, ...body });
        }
        return Promise.resolve(snapshot);
      }),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };

    const wrapper = mount(ModelManager, {
      props: { api, initialTab: "lane-prompts" },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    const saveButton = wrapper.get('[data-testid="lane-prompt-save"]');
    expect(saveButton.attributes("disabled")).toBeDefined();

    await wrapper.get('[data-testid="role-model-select"]').setValue("gpt-5.6");
    await settle(wrapper);
    expect(saveButton.attributes("disabled")).toBeUndefined();

    await saveButton.trigger("click");
    await settle(wrapper);
    expect(api.put).toHaveBeenCalledWith("/api/role-profiles/profile-acopilot", {
      model_id: "gpt-5.6",
      reasoning_effort: "high",
      system_prompt: prompt,
    });
    expect(api.put).not.toHaveBeenCalledWith("/api/lane-prompts/acopilot", { prompt });
    expect(saveButton.attributes("disabled")).toBeDefined();

    failRoleSave = true;
    await wrapper.get('[data-testid="role-model-select"]').setValue("gpt-5.5");
    await wrapper.get('[data-testid="lane-prompt-save"]').trigger("click");
    await settle(wrapper);
    expect(wrapper.get('[data-testid="lane-prompt-error"]').text()).toContain("role profile save failed");

    wrapper.unmount();
  });
});
