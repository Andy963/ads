import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";

import ActionsQueueStack from "../components/ActionsQueueStack.vue";
import type { ActionJobQueueItem } from "../lib/actionJobs";

const makeJob = (
  id: string,
  status: ActionJobQueueItem["status"] = "queued",
  overrides: Partial<ActionJobQueueItem> = {},
): ActionJobQueueItem => ({
  id,
  project_id: "p-1",
  issue_id: null,
  issue_title: `Synthetic task ${id}`,
  status,
  current_step: null,
  pr_number: null,
  pr_url: null,
  error_message: null,
  rework_count: 0,
  created_at: 1000,
  updated_at: 1000,
  ...overrides,
});

const mountStack = (jobs: ActionJobQueueItem[], props: Record<string, unknown> = {}) =>
  mount(ActionsQueueStack, {
    props: {
      jobs,
      activeJobId: null,
      starting: false,
      resetKey: "p-1",
      ...props,
    },
  });

const frontId = (wrapper: VueWrapper) =>
  wrapper.find('[data-testid="actions-queue-front"]').attributes("data-job-id");

const frontEl = (wrapper: VueWrapper): Element =>
  wrapper.find('[data-testid="actions-queue-front"]').element;

const firePointer = async (wrapper: VueWrapper, type: string, init: PointerEventInit = {}): Promise<void> => {
  frontEl(wrapper).dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 100,
      ...init,
    }),
  );
  await wrapper.vm.$nextTick();
};

const fireClick = async (wrapper: VueWrapper, selector: string, detail = 1): Promise<void> => {
  wrapper.find(selector).element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, detail }),
  );
  await wrapper.vm.$nextTick();
};

const drag = async (
  wrapper: VueWrapper,
  moves: number[],
  options: { startY?: number; end?: "up" | "cancel" | "lost" } = {},
) => {
  const startY = options.startY ?? 200;
  await firePointer(wrapper, "pointerdown", { clientY: startY });
  for (const y of moves) {
    await firePointer(wrapper, "pointermove", { clientY: y });
  }
  const lastY = moves[moves.length - 1] ?? startY;
  if (options.end === "cancel") {
    await firePointer(wrapper, "pointercancel", { clientY: lastY });
  } else if (options.end === "lost") {
    await firePointer(wrapper, "lostpointercapture");
  } else {
    await firePointer(wrapper, "pointerup", { clientY: lastY });
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActionsQueueStack bounded geometry", () => {
  it.each([1, 3, 10, 50])("keeps the rendered window bounded with %i jobs", (count) => {
    const jobs = Array.from({ length: count }, (_, i) => makeJob(`job-${i}`));
    const wrapper = mountStack(jobs);

    expect(wrapper.findAll('[data-testid="actions-queue-front"]')).toHaveLength(1);
    // At most three occluded edges, independent of queue depth.
    expect(wrapper.findAll('[data-testid="actions-queue-peek"]').length).toBe(Math.min(count - 1, 3));
    // Total stack offset never exceeds one card plus the fixed peek extent.
    const windowEl = wrapper.find(".actionsQueueStackWindow");
    expect(windowEl.attributes("style")).toContain(`padding-bottom: ${Math.min(count - 1, 3) * 6}px`);

    wrapper.unmount();
  });

  it("renders a single card with no fake background layers for one job, and nothing for zero jobs", () => {
    const single = mountStack([makeJob("only")]);
    expect(single.find('[data-testid="actions-queue-front"]').exists()).toBe(true);
    expect(single.findAll('[data-testid="actions-queue-peek"]')).toHaveLength(0);
    expect(single.find(".actionsQueueStackWindow").attributes("style")).toContain("padding-bottom: 0px");
    single.unmount();

    const empty = mountStack([]);
    expect(empty.find('[data-testid="actions-job-banner"]').exists()).toBe(false);
    empty.unmount();
  });

  it("renders no queue-count badge, header row, or scrollable list", () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b")]);
    expect(wrapper.find('[data-testid="actions-queue-count-badge"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Actions 队列");
    wrapper.unmount();
  });
});

describe("ActionsQueueStack occlusion and accessibility", () => {
  it("keeps hidden cards inert: aria-hidden, inert, and free of pointer/focus targets", () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b"), makeJob("c")]);
    const peeks = wrapper.findAll('[data-testid="actions-queue-peek"]');
    expect(peeks.length).toBeGreaterThan(0);
    for (const peek of peeks) {
      expect(peek.attributes("aria-hidden")).toBe("true");
      expect(peek.attributes("inert")).toBeDefined();
      expect(peek.find("button").exists()).toBe(false);
      expect(peek.find("[tabindex]").exists()).toBe(false);
      expect(peek.find("a").exists()).toBe(false);
    }
    const front = wrapper.find('[data-testid="actions-queue-front"]');
    expect(front.attributes("tabindex")).toBe("0");
    expect(front.attributes("aria-label")).toContain("Synthetic task a");
    expect(front.attributes("aria-label")).toContain("job 1 of 3");
    wrapper.unmount();
  });

  it("exposes the full title through the title attribute and keeps metadata-only content", () => {
    const wrapper = mountStack([
      makeJob("long", "queued", {
        issue_id: 7,
        issue_title: "A very long synthetic title mixing Latin and 汉字 characters that must not overflow",
        current_step: "Developer is running the test suite",
        error_message: "synthetic failure detail",
      }),
    ]);
    const front = wrapper.find('[data-testid="actions-queue-front"]');
    const title = front.find(".actionsQueueCardTitle");
    expect(title.attributes("title")).toContain("A very long synthetic title");
    expect(title.attributes("title")).toContain("#7:");
    // No developer steps or error logs inside the stack.
    expect(front.text()).not.toContain("Developer is running the test suite");
    expect(front.text()).not.toContain("synthetic failure detail");
    wrapper.unmount();
  });
});

describe("ActionsQueueStack selection vs execution state", () => {
  it("defaults to the active execution job, then the first queued job", () => {
    const running = mountStack(
      [makeJob("run", "running"), makeJob("wait", "queued")],
      { activeJobId: "run" },
    );
    expect(frontId(running)).toBe("run");
    running.unmount();

    const idle = mountStack([makeJob("first"), makeJob("second")], { activeJobId: null });
    expect(frontId(idle)).toBe("first");
    idle.unmount();
  });

  it("does not snap the browsed selection back when statuses change or jobs are appended", async () => {
    const wrapper = mountStack([makeJob("run", "running"), makeJob("b"), makeJob("c")], { activeJobId: "run" });
    expect(frontId(wrapper)).toBe("run");

    await wrapper.find('[data-testid="actions-queue-front"]').trigger("keydown", { key: "ArrowDown" });
    expect(frontId(wrapper)).toBe("b");

    // A status transition on the active job and a newly queued job arrive.
    await wrapper.setProps({
      jobs: [makeJob("run", "verifying"), makeJob("b"), makeJob("c"), makeJob("d")],
      activeJobId: "run",
    });
    expect(frontId(wrapper)).toBe("b");
    wrapper.unmount();
  });

  it("falls back to the job that slid into the vacated slot, or the previous neighbour at the tail", async () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b"), makeJob("c")]);
    await wrapper.find('[data-testid="actions-queue-front"]').trigger("keydown", { key: "ArrowDown" });
    expect(frontId(wrapper)).toBe("b");

    // b leaves the queue: c slid into its slot.
    await wrapper.setProps({ jobs: [makeJob("a"), makeJob("c")] });
    expect(frontId(wrapper)).toBe("c");

    // c was the last card: fall back to the previous neighbour.
    await wrapper.setProps({ jobs: [makeJob("a")] });
    expect(frontId(wrapper)).toBe("a");
    wrapper.unmount();
  });

  it("resets selection to the scope default and survives gestures when the reset key changes", async () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b")], { resetKey: "project-1" });
    await wrapper.find('[data-testid="actions-queue-front"]').trigger("keydown", { key: "ArrowDown" });
    expect(frontId(wrapper)).toBe("b");

    await wrapper.setProps({ resetKey: "project-2" });
    expect(frontId(wrapper)).toBe("a");
    wrapper.unmount();
  });

  it("binds actions to the visible job: browsing a queued card never cancels the running job", async () => {
    const wrapper = mountStack([makeJob("run", "running"), makeJob("wait", "queued")], { activeJobId: "run" });
    const front = wrapper.find('[data-testid="actions-queue-front"]');

    // Running job: Cancel is offered, Start is not.
    expect(front.find('[data-testid="btn-action-cancel"]').exists()).toBe(true);
    expect(front.find('[data-testid="btn-action-start"]').exists()).toBe(false);

    await front.trigger("keydown", { key: "ArrowDown" });
    expect(frontId(wrapper)).toBe("wait");

    // The queued card still cannot offer Start while another job executes, and
    // its Cancel targets the visible job, not the running one.
    expect(front.find('[data-testid="btn-action-start"]').exists()).toBe(false);
    await front.find('[data-testid="btn-action-cancel"]').trigger("click");
    expect(wrapper.emitted("cancel")).toEqual([["wait"]]);
    wrapper.unmount();
  });
});

describe("ActionsQueueStack vertical drag gestures", () => {
  it("advances on an upward drag past the settle distance and returns on a downward drag", async () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b"), makeJob("c")]);

    // Drag up (towards smaller clientY) beyond 40px -> next job.
    await drag(wrapper, [190, 170, 150]);
    expect(frontId(wrapper)).toBe("b");

    // Drag down past the threshold -> previous job.
    await drag(wrapper, [210, 230, 245]);
    expect(frontId(wrapper)).toBe("a");
    wrapper.unmount();
  });

  it("snaps back when the release is below the distance and velocity thresholds", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const wrapper = mountStack([makeJob("a"), makeJob("b")]);

    // 25px over 300ms: below the 40px distance and 0.35px/ms flick thresholds.
    await firePointer(wrapper, "pointerdown", { clientY: 200 });
    now += 300;
    await firePointer(wrapper, "pointermove", { clientY: 175 });
    await firePointer(wrapper, "pointerup", { clientY: 175 });
    expect(frontId(wrapper)).toBe("a");
    wrapper.unmount();
  });

  it("advances on a fast flick even below the settle distance", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const wrapper = mountStack([makeJob("a"), makeJob("b")]);

    await firePointer(wrapper, "pointerdown", { clientY: 200 });
    now += 16;
    await firePointer(wrapper, "pointermove", { clientY: 188 });
    now += 16;
    await firePointer(wrapper, "pointermove", { clientY: 176 });
    await firePointer(wrapper, "pointerup", { clientY: 176 });
    // 24px in 32ms ≈ 0.75px/ms -> flick.
    expect(frontId(wrapper)).toBe("b");
    wrapper.unmount();
  });

  it("ignores a flick whose finger went stale before release", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const wrapper = mountStack([makeJob("a"), makeJob("b")]);

    await firePointer(wrapper, "pointerdown", { clientY: 200 });
    now += 16;
    await firePointer(wrapper, "pointermove", { clientY: 180 });
    // Finger held still for 200ms before release: not a flick, below distance.
    now += 200;
    await firePointer(wrapper, "pointerup", { clientY: 180 });
    expect(frontId(wrapper)).toBe("a");
    wrapper.unmount();
  });

  it("does not wrap at the first or last card", async () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b")]);

    // At the first card a downward drag has nowhere to go.
    await drag(wrapper, [220, 260]);
    expect(frontId(wrapper)).toBe("a");

    await drag(wrapper, [180, 140]);
    expect(frontId(wrapper)).toBe("b");

    // At the last card an upward drag stays put.
    await drag(wrapper, [180, 140]);
    expect(frontId(wrapper)).toBe("b");
    wrapper.unmount();
  });

  it("reaches every job in queue order with repeated gestures", async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => makeJob(`job-${i}`));
    const wrapper = mountStack(jobs);
    for (let i = 1; i < jobs.length; i += 1) {
      await drag(wrapper, [190, 150]);
      expect(frontId(wrapper)).toBe(`job-${i}`);
    }
    for (let i = jobs.length - 2; i >= 0; i -= 1) {
      await drag(wrapper, [210, 250]);
      expect(frontId(wrapper)).toBe(`job-${i}`);
    }
    wrapper.unmount();
  });

  it.each(["cancel", "lost"] as const)("settles back to the current card on %s mid-drag", async (end) => {
    const wrapper = mountStack([makeJob("a"), makeJob("b")]);
    await drag(wrapper, [190, 150], { end });
    expect(frontId(wrapper)).toBe("a");
    // The stack is not left between cards: no residual drag transform.
    const front = wrapper.find('[data-testid="actions-queue-front"]');
    expect(front.attributes("style") ?? "").not.toContain("translateY(150px)");
    wrapper.unmount();
  });

  it("suppresses the click that follows a completed drag but keeps plain taps working", async () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b")]);

    await drag(wrapper, [190, 150]);
    expect(frontId(wrapper)).toBe("b");

    // The click the browser fires after the drag must not reach the buttons.
    await fireClick(wrapper, '[data-testid="btn-action-cancel"]');
    expect(wrapper.emitted("cancel")).toBeUndefined();

    // After the suppression window a genuine activation goes through.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 1000);
    await fireClick(wrapper, '[data-testid="btn-action-cancel"]');
    expect(wrapper.emitted("cancel")).toEqual([["b"]]);
    wrapper.unmount();
  });

  it("treats a stationary press as a tap: selection unchanged, click works", async () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b")]);

    await drag(wrapper, [202, 200]);
    expect(frontId(wrapper)).toBe("a");

    await fireClick(wrapper, '[data-testid="btn-action-cancel"]');
    expect(wrapper.emitted("cancel")).toEqual([["a"]]);
    wrapper.unmount();
  });

  it("lets horizontal movement fall through to the lane swipe", async () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b")]);
    await firePointer(wrapper, "pointerdown", { clientY: 200 });
    await firePointer(wrapper, "pointermove", { clientX: 160, clientY: 190 });
    // Later vertical travel in the same press must not hijack the horizontal gesture.
    await firePointer(wrapper, "pointermove", { clientX: 160, clientY: 140 });
    await firePointer(wrapper, "pointerup", { clientX: 160, clientY: 140 });
    expect(frontId(wrapper)).toBe("a");
    wrapper.unmount();
  });
});

describe("ActionsQueueStack keyboard navigation", () => {
  it("browses with arrow keys, clamped at both ends", async () => {
    const wrapper = mountStack([makeJob("a"), makeJob("b"), makeJob("c")]);
    const front = wrapper.find('[data-testid="actions-queue-front"]');

    await front.trigger("keydown", { key: "ArrowUp" });
    expect(frontId(wrapper)).toBe("a");

    await front.trigger("keydown", { key: "ArrowDown" });
    await front.trigger("keydown", { key: "ArrowDown" });
    expect(frontId(wrapper)).toBe("c");
    expect(front.attributes("aria-label")).toContain("job 3 of 3");

    await front.trigger("keydown", { key: "ArrowDown" });
    expect(frontId(wrapper)).toBe("c");
    wrapper.unmount();
  });
});

describe("ActionsQueueStack front card metadata layout", () => {
  it("keeps status and actions in one inline first row without side columns", () => {
    const wrapper = mountStack([
      makeJob("blocked-1", "blocked", { blocked_at: 1_700_000_000_000 - 30 * 60_000 }),
    ]);
    const front = wrapper.find('[data-testid="actions-queue-front"]');
    const meta = front.find(".actionsQueueCardMeta");
    expect(meta.exists()).toBe(true);
    // Badge, actions, and title share one inline block (float layout), and the
    // blocked duration is the only secondary line.
    expect(meta.find(".actionsJobBadge").exists()).toBe(true);
    expect(meta.find('[data-testid="btn-action-resolve-dismiss"]').exists()).toBe(true);
    expect(meta.find(".actionsQueueCardTitle").exists()).toBe(true);
    expect(front.find(".actionsJobBlockedFor").text()).toContain("Blocked for");
    // Queued jobs carry no redundant "queued" subtitle.
    expect(front.find(".actionsJobStep").exists()).toBe(false);
    wrapper.unmount();
  });
});
