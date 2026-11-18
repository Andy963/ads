import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

import SessionResumePicker from "../components/SessionResumePicker.vue";
import type { ResumableSession } from "../app/controllerTypes";

const elIconStub = { name: "ElIcon", template: "<i><slot /></i>" };

function makeSession(overrides: Partial<ResumableSession> = {}): ResumableSession {
  return {
    agentId: "codex",
    sessionId: "sess-1",
    cwd: "/repo",
    title: "修复登录超时",
    updatedAt: Date.now() - 5 * 60_000,
    source: "ads_link",
    ...overrides,
  };
}

function mountPicker(props: Partial<InstanceType<typeof SessionResumePicker>["$props"]> = {}) {
  return mount(SessionResumePicker, {
    props: {
      sessions: [],
      busy: false,
      error: null,
      agentId: "codex",
      ...props,
    } as never,
    global: { stubs: { "el-icon": elIconStub } },
  });
}

describe("SessionResumePicker", () => {
  it("requests the session list as soon as it mounts", () => {
    const wrapper = mountPicker();
    const refreshes = wrapper.emitted("refresh");
    expect(refreshes).toHaveLength(1);
    expect(refreshes?.[0][0]).toEqual({ search: undefined, includeAllCwds: false, includeNoise: false });
  });

  it("emits the provider session id when a row is clicked", async () => {
    const wrapper = mountPicker({ sessions: [makeSession({ sessionId: "abc-123" })] });
    await wrapper.get('[data-testid="session-picker-item-abc-123"]').trigger("click");
    expect(wrapper.emitted("resume")?.[0]).toEqual(["abc-123"]);
  });

  it("emits an undefined id for the latest-session shortcut", async () => {
    const wrapper = mountPicker({ sessions: [makeSession()] });
    await wrapper.get('[data-testid="session-picker-latest"]').trigger("click");
    expect(wrapper.emitted("resume")?.[0]).toEqual([undefined]);
  });

  it("does not emit resume while the lane is busy", async () => {
    const wrapper = mountPicker({ sessions: [makeSession({ sessionId: "abc-123" })], disabled: true });
    await wrapper.get('[data-testid="session-picker-item-abc-123"]').trigger("click");
    expect(wrapper.emitted("resume")).toBeUndefined();
  });

  it("shows an empty state when no sessions are returned", () => {
    const wrapper = mountPicker();
    expect(wrapper.find('[data-testid="session-picker-empty"]').exists()).toBe(true);
  });

  it("marks the current session and falls back to the id when a title is missing", () => {
    const wrapper = mountPicker({
      sessions: [makeSession({ sessionId: "deadbeef-1111", title: undefined, isCurrent: true })],
    });
    const row = wrapper.get('[data-testid="session-picker-item-deadbeef-1111"]');
    expect(row.text()).toContain("会话 deadbeef");
    expect(row.text()).toContain("当前");
  });

  it("re-requests the list when the cwd filter is toggled", async () => {
    const wrapper = mountPicker();
    await wrapper.get('[data-testid="session-picker-all-cwds"]').setValue(true);
    const refreshes = wrapper.emitted("refresh");
    expect(refreshes).toHaveLength(2);
    expect(refreshes?.[1][0]).toEqual({ search: undefined, includeAllCwds: true, includeNoise: false });
  });

  it("debounces search input into a single refresh", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountPicker();
      await wrapper.get('[data-testid="session-picker-search"]').setValue("登录");
      await wrapper.get('[data-testid="session-picker-search"]').setValue("登录超时");
      vi.advanceTimersByTime(300);
      await wrapper.vm.$nextTick();

      const refreshes = wrapper.emitted("refresh");
      expect(refreshes).toHaveLength(2);
      expect(refreshes?.[1][0]).toEqual({ search: "登录超时", includeAllCwds: false, includeNoise: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a backend error message", () => {
    const wrapper = mountPicker({ error: "部分来源不可用，列表可能不完整" });
    expect(wrapper.get('[data-testid="session-picker-error"]').text()).toContain("部分来源不可用");
  });

  it("reports withheld noise instead of silently shortening the list", () => {
    const wrapper = mountPicker({ hidden: { singleTurn: 35, duplicates: 4 } });
    const hint = wrapper.get('[data-testid="session-picker-hidden"]');
    expect(hint.text()).toContain("35 个一次性会话");
    expect(hint.text()).toContain("4 个重名会话");
  });

  it("stays silent when nothing was withheld", () => {
    const wrapper = mountPicker({ hidden: { singleTurn: 0, duplicates: 0 } });
    expect(wrapper.find('[data-testid="session-picker-hidden"]').exists()).toBe(false);
  });

  it("re-requests with noise included when the reveal link is clicked", async () => {
    const wrapper = mountPicker({ hidden: { singleTurn: 35, duplicates: 0 } });
    await wrapper.get('[data-testid="session-picker-show-all"]').trigger("click");
    const refreshes = wrapper.emitted("refresh");
    expect(refreshes).toHaveLength(2);
    expect(refreshes?.[1][0]).toEqual({ search: undefined, includeAllCwds: false, includeNoise: true });
    // The notice is what the link acted on, so it must not linger afterwards.
    expect(wrapper.find('[data-testid="session-picker-hidden"]').exists()).toBe(false);
  });

  it("shows how many same-titled sessions a collapsed row stands for", () => {
    const wrapper = mountPicker({
      sessions: [makeSession({ sessionId: "dup-1", title: "继续", duplicateCount: 25 })],
    });
    expect(wrapper.get('[data-testid="session-picker-item-dup-1"]').text()).toContain("×25");
  });

  it("explains why resuming is unavailable rather than just greying rows out", () => {
    const wrapper = mountPicker({ disabled: true, disabledReason: "有任务正在运行，结束后才能恢复其它会话" });
    expect(wrapper.get('[data-testid="session-picker-disabled"]').text()).toContain("有任务正在运行");
  });

  it("offers to load the next page only while the backend reports one", async () => {
    const wrapper = mountPicker({ sessions: [makeSession()], nextCursor: "opaque" });
    await wrapper.get('[data-testid="session-picker-load-more"]').trigger("click");
    expect(wrapper.emitted("load-more")).toHaveLength(1);

    const exhausted = mountPicker({ sessions: [makeSession()], nextCursor: null });
    expect(exhausted.find('[data-testid="session-picker-load-more"]').exists()).toBe(false);
  });

  it("does not stack page requests while one is in flight", async () => {
    const wrapper = mountPicker({ sessions: [makeSession()], nextCursor: "opaque", busy: true });
    await wrapper.get('[data-testid="session-picker-load-more"]').trigger("click");
    expect(wrapper.emitted("load-more")).toBeUndefined();
  });

  it("offers a long-idle session with no age caveat", async () => {
    // Idle time no longer gates resuming, so the row must carry no timeout badge
    // or hint: either would tell the user this session is second-class when it
    // reattaches exactly like any other.
    const wrapper = mountPicker({
      sessions: [makeSession({ sessionId: "old-1", updatedAt: Date.now() - 30 * 24 * 3_600_000 })],
    });
    expect(wrapper.find('[data-testid="session-picker-stale-old-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="session-picker-stale-hint"]').exists()).toBe(false);

    await wrapper.get('[data-testid="session-picker-item-old-1"]').trigger("click");
    expect(wrapper.emitted("resume")?.[0]).toEqual(["old-1"]);
  });

  it("explains that fork chains were folded into their newest session", () => {
    const wrapper = mountPicker({
      sessions: [makeSession({ sessionId: "lane-a", forkCount: 53 })],
      hidden: { singleTurn: 0, duplicates: 0, forks: 52 },
    });
    expect(wrapper.get('[data-testid="session-picker-forks"]').text()).toContain("52 个同对话的历史分支");
    expect(wrapper.get('[data-testid="session-picker-forks-lane-a"]').text()).toContain("53");
    // Forks are not revealable, so they must stay out of the "显示全部" notice.
    expect(wrapper.find('[data-testid="session-picker-hidden"]').exists()).toBe(false);
  });
});
