import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import type { GlobalRule } from "../api/types";
import GlobalRuleManager from "../components/GlobalRuleManager.vue";

function makeRule(overrides: Partial<GlobalRule> = {}): GlobalRule {
  return {
    id: "rule-1",
    title: "进程自保",
    body: "禁止 pkill",
    category: "execution",
    severity: "blocked",
    enabled: true,
    priority: 10,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    updatedBy: "andy",
    match: { tools: ["shell"], commandPatterns: ["\\bpkill\\b"] },
    ...overrides,
  };
}

function makeApi(rules: GlobalRule[]) {
  const get = vi.fn().mockImplementation((path: string) => {
    if (path.startsWith("/api/global-rules/preview")) {
      return Promise.resolve({
        text: "<global_rules>\n...\n</global_rules>",
        hash: "abcdef123456",
        source: "database",
        degraded: false,
        ruleCount: rules.length,
      });
    }
    if (path.startsWith("/api/global-rules/audit")) {
      return Promise.resolve({ entries: [] });
    }
    return Promise.resolve({ rules });
  });
  return {
    get,
    post: vi.fn(),
    patch: vi.fn().mockResolvedValue(rules[0]),
    put: vi.fn(),
    delete: vi.fn().mockResolvedValue({ success: true }),
  };
}

async function settle(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("GlobalRuleManager", () => {
  it("can hide the desktop header for embedded mobile navigation", async () => {
    const api = makeApi([makeRule()]);
    const wrapper = mount(GlobalRuleManager, { props: { api: api as never, showHeader: false } });
    await settle(wrapper);

    expect(wrapper.find(".ruleHeader").exists()).toBe(false);
    expect(wrapper.find(".ruleTabs").exists()).toBe(true);
  });

  it("can hide the add-rule button for embedded mobile navigation", async () => {
    const api = makeApi([makeRule()]);
    const wrapper = mount(GlobalRuleManager, { props: { api: api as never, showAddButton: false } });
    await settle(wrapper);

    expect(wrapper.find('[data-testid="global-rule-add"]').exists()).toBe(false);
    expect(wrapper.find(".ruleTabs").exists()).toBe(true);
  });

  it("renders one row per rule with its severity and enforceability", async () => {
    const api = makeApi([makeRule(), makeRule({ id: "rule-2", title: "文档位置", severity: "required", match: null })]);
    const wrapper = mount(GlobalRuleManager, { props: { api: api as never } });
    await settle(wrapper);

    expect(wrapper.find('[data-testid="global-rule-row-rule-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="global-rule-row-rule-2"]').exists()).toBe(true);
    const first = wrapper.find('[data-testid="global-rule-row-rule-1"]').text();
    expect(first).toContain("blocked");
    expect(first).toContain("可拦截");
    // A prose-only rule must not claim it can block anything.
    expect(wrapper.find('[data-testid="global-rule-row-rule-2"]').text()).not.toContain("可拦截");
  });

  it("edits a rule through the dialog and sends only the edited fields", async () => {
    const api = makeApi([makeRule()]);
    const wrapper = mount(GlobalRuleManager, { props: { api: api as never } });
    await settle(wrapper);

    await wrapper.find('[data-testid="global-rule-edit-rule-1"]').trigger("click");
    expect(wrapper.find('[data-testid="global-rule-dialog"]').exists()).toBe(true);

    await wrapper.find('[data-testid="global-rule-title"]').setValue("进程自保 v2");
    await wrapper.find('[data-testid="global-rule-dialog"]').trigger("submit");
    await settle(wrapper);

    expect(api.patch).toHaveBeenCalledTimes(1);
    const [path, payload] = api.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/api/global-rules/rule-1");
    expect(payload.title).toBe("进程自保 v2");
    expect(payload.severity).toBe("blocked");
    expect(payload.match).toMatchObject({ commandPatterns: ["\\bpkill\\b"] });
  });

  it("blocks saving while a pattern cannot be compiled", async () => {
    const api = makeApi([makeRule()]);
    const wrapper = mount(GlobalRuleManager, { props: { api: api as never } });
    await settle(wrapper);

    await wrapper.find('[data-testid="global-rule-edit-rule-1"]').trigger("click");
    await wrapper.find('[data-testid="global-rule-command-patterns"]').setValue("([unclosed");
    await wrapper.vm.$nextTick();

    const save = wrapper.find('[data-testid="global-rule-save"]');
    expect(save.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("正则无法编译");
  });

  it("requires a second click to delete a rule", async () => {
    const api = makeApi([makeRule()]);
    const wrapper = mount(GlobalRuleManager, { props: { api: api as never } });
    await settle(wrapper);

    await wrapper.find('[data-testid="global-rule-delete-rule-1"]').trigger("click");
    expect(api.delete).not.toHaveBeenCalled();

    await wrapper.find('[data-testid="global-rule-delete-confirm-rule-1"]').trigger("click");
    await settle(wrapper);
    expect(api.delete).toHaveBeenCalledWith("/api/global-rules/rule-1");
  });

  it("shows the decision returned by the rule test panel", async () => {
    const api = makeApi([makeRule()]);
    api.post = vi.fn().mockResolvedValue({
      decision: "deny",
      effectiveDecision: "allow",
      mode: "observe",
      hits: [{ ruleId: "rule-1", title: "进程自保", category: "execution", severity: "blocked", matchedOn: "command:\\bpkill\\b" }],
    });
    const wrapper = mount(GlobalRuleManager, { props: { api: api as never } });
    await settle(wrapper);

    await wrapper.find('[data-testid="global-rule-test-command"]').setValue("pkill -f node");
    await wrapper.find('[data-testid="global-rule-test-run"]').trigger("click");
    await settle(wrapper);

    const result = wrapper.find('[data-testid="global-rule-test-result"]').text();
    expect(result).toContain("deny");
    expect(result).toContain("进程自保");
  });

  it("warns when the rule database has degraded to bootstrap rules", async () => {
    const api = makeApi([]);
    api.get = vi.fn().mockImplementation((path: string) => {
      if (path.startsWith("/api/global-rules/preview")) {
        return Promise.resolve({
          text: "<global_rules>\n[degraded]\n</global_rules>",
          hash: "0000000000",
          source: "bootstrap",
          degraded: true,
          ruleCount: 1,
        });
      }
      if (path.startsWith("/api/global-rules/audit")) {
        return Promise.resolve({ entries: [] });
      }
      return Promise.resolve({ rules: [] });
    });

    const wrapper = mount(GlobalRuleManager, { props: { api: api as never } });
    await settle(wrapper);
    expect(wrapper.find('[data-testid="global-rule-degraded"]').exists()).toBe(true);
  });
});
